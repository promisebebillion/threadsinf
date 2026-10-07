import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { request, type APIRequestContext, type BrowserContext, type Route } from "playwright";
import { checkBrowserIP, editProxy, holdProxy, openProxyContext, proxyCheckFailure, proxyInputSchema, readDirectIP, requireDifferentIP, requireThreadsResponse, recheckProxyContext, waitForThreadsInterface } from "./account-proxies.js";
import { createThreadsBrowser } from "./browser-sessions.js";
import { prisma } from "./db.js";

test("proxy input rejects private addresses, URL credentials and invalid ports", () => {
  const input = { host: "8.8.8.8", port: 8000, login: "login", password: "secret" };
  assert.equal(proxyInputSchema.parse(input).host, input.host);
  for (const host of ["127.0.0.1", "10.1.1.1", "169.254.169.254", "192.168.0.1", "198.18.0.2", "http://8.8.8.8", "8.8.8.8@127.0.0.1", "::1", "008.8.8.8"])
    assert.equal(proxyInputSchema.safeParse({ ...input, host }).success, false, host);
  for (const port of [0, -1, 65536, 2.5]) assert.equal(proxyInputSchema.safeParse({ ...input, port }).success, false);
});

test("same or malformed exit IP fails closed, and missing assignment never launches a browser", async () => {
  assert.throws(() => requireDifferentIP("8.8.8.8", "8.8.8.8"), /matches/);
  assert.throws(() => requireDifferentIP("8.8.8.8", "garbage"), /invalid/);
  requireDifferentIP("8.8.8.8", "9.9.9.9");
  await assert.rejects(openProxyContext(undefined, true), /Assign a proxy/);
});

test("proxy diagnostics distinguish timeout and authentication without leaking raw errors", () => {
  assert.match(proxyCheckFailure(new Error("page.goto: Timeout 20000ms exceeded. PRIVATE")).userMessage, /20 seconds/);
  assert.match(proxyCheckFailure(new Error("net::ERR_INVALID_AUTH_CREDENTIALS PRIVATE")).userMessage, /rejected authentication/);
  assert.match(proxyCheckFailure(new Error("net::ERR_PROXY_CONNECTION_FAILED PRIVATE")).userMessage, /VPN\/network/);
  assert.doesNotMatch(proxyCheckFailure(new Error("PRIVATE secret internal error")).userMessage, /PRIVATE|secret/);
});

test("a reset primary IP service falls back to a valid HTTPS result and rejects invalid results", async (t) => {
  const urls: string[] = [];
  let fallback = "8.8.4.4\n";
  let disposed = 0;
  t.mock.method(request, "newContext", async () => ({
    get: async (url: string) => {
      urls.push(url);
      if (url.includes("ipify")) throw new Error("ECONNRESET");
      return { ok: () => true, text: async () => fallback };
    },
    dispose: async () => { disposed++; },
  } as unknown as APIRequestContext));
  assert.equal(await readDirectIP(), "8.8.4.4");
  assert.deepEqual(urls, ["https://api.ipify.org/?format=json", "https://checkip.amazonaws.com/"]);
  fallback = "10.0.0.1";
  await assert.rejects(readDirectIP(), /Both services/);
  assert.equal(disposed, 2);
});

test("settings cannot change while any browser holds the account, including pending opens", async () => {
  const owner = { userId: "lease-test", username: "profile" };
  const releaseFirst = holdProxy(owner);
  const releaseSecond = holdProxy(owner);
  await assert.rejects(editProxy(owner, async () => "changed"), /Close this account/);
  releaseFirst(); releaseFirst();
  await assert.rejects(editProxy(owner, async () => "changed"), /Close this account/);
  releaseSecond();
  await editProxy(owner, async () => assert.throws(() => holdProxy(owner), /being changed/));
  assert.equal(await editProxy(owner, async () => "changed"), "changed");
});

test("IP guard blocks Threads until both lookups succeed and remains closed on failure", async () => {
  for (const scenario of ["success", "proxy-failure", "direct-failure", "same-ip"] as const) {
    let guard: ((route: Route) => Promise<void>) | undefined;
    let unguarded = false;
    const context = {
      route: async (_pattern: string, handler: typeof guard) => { guard = handler; },
      unroute: async () => { unguarded = true; },
      newPage: async () => { assert.fail("IP verification must not open a diagnostic tab"); },
      request: {
        get: async () => {
          let blocked = false;
          await guard!({ request: () => ({ url: () => "https://www.threads.com/login" }), abort: async () => { blocked = true; }, continue: async () => {} } as unknown as Route);
          assert.equal(blocked, true);
          if (scenario === "proxy-failure") throw new Error("proxy auth failed with SECRET");
          return { status: () => 200, ok: () => true, url: () => "https://api.ipify.org/?format=json", json: async () => ({ ip: scenario === "same-ip" ? "8.8.8.8" : "9.9.9.9" }) };
        },
      },
    } as unknown as BrowserContext;
    const operation = checkBrowserIP(context, async () => {
      if (scenario === "direct-failure") throw new Error("network failed");
      return "8.8.8.8";
    });
    if (scenario === "success") assert.deepEqual(await operation, { directIp: "8.8.8.8", exitIp: "9.9.9.9" });
    else await assert.rejects(operation, (error: Error) => !error.message.includes("SECRET"));
    assert.equal(unguarded, scenario === "success");
  }
});

test("a successful IP check followed by a Threads reset never sets verified and keeps IP evidence", async (t) => {
  let saved: unknown;
  let closed = false;
  const delegate = prisma.accountProxy;
  prisma.accountProxy = {
    update: async () => assert.fail("A blocked Threads page must not be marked verified"),
    updateMany: async (args: { data: unknown }) => { saved = args.data; return { count: 1 }; },
  } as unknown as typeof delegate;
  t.after(() => { prisma.accountProxy = delegate; });
  t.mock.method(request, "newContext", async () => ({
    get: async () => ({ ok: () => true, json: async () => ({ ip: "8.8.8.8" }) }), dispose: async () => {},
  } as unknown as APIRequestContext));
  const context = {
    route: async () => {}, unroute: async () => {},
    request: { get: async (url: string) => {
      if (url.includes("threads")) throw new Error("net::ERR_CONNECTION_RESET secret");
      return { ok: () => true, status: () => 200, url: () => url, json: async () => ({ ip: "9.9.9.9" }) };
    } },
    browser: () => ({ close: async () => { closed = true; } }),
  } as unknown as BrowserContext;
  await assert.rejects(recheckProxyContext({ userId: "fixture", username: "fixture" }, context), /Proxy IP verified, but Threads is unavailable: the connection was reset/);
  const data = saved as { status: string; exitIp: string; directIp: string; error: string };
  assert.equal(data.status, "failed");
  assert.equal(data.exitIp, "9.9.9.9");
  assert.equal(data.directIp, "8.8.8.8");
  assert.doesNotMatch(data.error, /secret/);
  assert.equal(closed, true);
});

test("Threads reachability rejects proxy error pages and HTTP failures", () => {
  const response = { status: () => 200, url: () => "https://www.threads.com/login", headers: () => ({ "content-type": "text/html; charset=utf-8" }) };
  requireThreadsResponse(response);
  assert.throws(() => requireThreadsResponse({ ...response, status: () => 403 }), /HTTP 403/);
  assert.throws(() => requireThreadsResponse({ ...response, url: () => "https://proxy.example/error" }), /did not return its page/);
  assert.throws(() => requireThreadsResponse({ ...response, headers: () => ({ "content-type": "application/json" }) }), /did not return its page/);
});

test("a page containing only the app QR shell is not ready; a visible login form is", async () => {
  const browser = await createThreadsBrowser({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<title>Threads • Log in</title><div>Scan to get the app</div>');
    await assert.rejects(waitForThreadsInterface(page, 150), /login interface did not load/);
    await page.setContent('<h1>Log in</h1><input type="password">');
    await waitForThreadsInterface(page, 1000);
  } finally { await browser.close(); }
});

test("real Chromium uses authenticated HTTP proxy and never falls back after the proxy dies", async () => {
  let directHits = 0;
  let authorized = 0;
  const tunnels = new Set<Socket>();
  const destination = createServer((_request, response) => { directHits++; response.end("DIRECT"); });
  const proxy = createServer((request, response) => {
    if (request.headers["proxy-authorization"] !== `Basic ${Buffer.from("fixture:password").toString("base64")}`) {
      response.writeHead(407, { "Proxy-Authenticate": 'Basic realm="fixture"' }); response.end(); return;
    }
    authorized++;
    response.writeHead(200, { "content-type": "text/plain", connection: "close" }); response.end("THROUGH PROXY");
  });
  proxy.on("connect", (request, socket) => {
    if (request.headers["proxy-authorization"] !== `Basic ${Buffer.from("fixture:password").toString("base64")}`) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="fixture"\r\nConnection: close\r\n\r\n'); return;
    }
    tunnels.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => tunnels.delete(socket));
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 13\r\nConnection: close\r\n\r\nTHROUGH PROXY"));
  });
  await new Promise<void>((resolve) => destination.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const browser = await createThreadsBrowser({ headless: true, proxy: {
    server: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, username: "fixture", password: "password",
  } });
  try {
    const page = await browser.newPage();
    const url = `http://127.0.0.1:${(destination.address() as AddressInfo).port}/`;
    await page.goto(url);
    assert.equal(await page.locator("body").innerText(), "THROUGH PROXY");
    assert.ok(authorized > 0);
    const apiResponse = await page.context().request.get(url);
    assert.equal(await apiResponse.text(), "THROUGH PROXY");
    for (const socket of tunnels) socket.destroy();
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await assert.rejects(page.goto(url + "after-failure", { timeout: 5000 }));
    assert.equal(directHits, 0);
  } finally {
    await browser.close();
    for (const socket of tunnels) socket.destroy();
    proxy.closeAllConnections(); proxy.close();
    destination.closeAllConnections(); destination.close();
  }
});

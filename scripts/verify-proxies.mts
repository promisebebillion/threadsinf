import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import dotenv from "dotenv";
dotenv.config({ path: new URL("../apps/api/.env", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), quiet: true });
const { prisma } = await import("../apps/api/src/db.js");
const { createApp } = await import("../apps/api/src/app.js");
const { hashToken, randomToken, decryptToken } = await import("../apps/api/src/security.js");
const { browserSessions } = await import("../apps/api/src/browser-sessions.js");
const { config } = await import("../apps/api/src/config.js");
const { holdProxy } = await import("../apps/api/src/account-proxies.js");
const created: string[] = [];
const server = createApp().listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/accounts`;
async function user() {
  const id = randomUUID();
  await prisma.user.create({ data: { id, email: `proxy-check-${id}@example.test`, name: "Temporary proxy verification", passwordHash: "unusable-test-login" } });
  created.push(id);
  const token = randomToken();
  await prisma.session.create({ data: { userId: id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 300_000) } });
  return { id, cookie: `threadflow_session=${token}` };
}
async function call(cookie: string, method: string, path: string, body?: unknown) {
  const response = await fetch(base + path, { method,
    headers: { origin: config.frontendOrigin, "x-threadflow-client": "web", "content-type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000),
  });
  const data = response.status === 204 ? null : await response.json();
  assert.ok(!JSON.stringify(data).includes("fixture-secret"), "Password escaped API");
  return { status: response.status, data };
}
try {
  const alice = await user(); const bob = await user();
  const preflight = await fetch(base + "/proxies/profile.one", { method: "OPTIONS", headers: { origin: config.frontendOrigin, "access-control-request-method": "PUT", "access-control-request-headers": "content-type,x-threadflow-client" } });
  assert.ok(preflight.headers.get("access-control-allow-methods")?.includes("PUT"));
  const input = { host: "8.8.8.8", port: 8000, login: "fixture", password: "fixture-secret" };
  assert.equal((await call("", "GET", "/proxies")).status, 401);
  assert.equal((await call(alice.cookie, "PUT", "/proxies/profile.one", input)).status, 200);
  const stored = await prisma.accountProxy.findUniqueOrThrow({ where: { userId_username: { userId: alice.id, username: "profile.one" } } });
  assert.notEqual(stored.password, input.password);
  assert.equal(decryptToken(stored.password), input.password);
  assert.equal((await call(alice.cookie, "PUT", "/proxies/profile.two", { ...input, login: "different" })).status, 409);
  const race = await Promise.all(["race.one", "race.two"].map((username) => call(alice.cookie, "PUT", `/proxies/${username}`, { ...input, host: "9.9.9.9" })));
  assert.deepEqual(race.map((result) => result.status).sort(), [200, 409]);
  assert.deepEqual((await call(bob.cookie, "GET", "/proxies")).data, []);
  assert.equal((await call(bob.cookie, "POST", "/proxies/profile.one/check")).status, 409);
  await call(bob.cookie, "DELETE", "/proxies/profile.one");
  assert.equal(await prisma.accountProxy.count({ where: { userId: alice.id, username: "profile.one" } }), 1);
  const withoutPassword = { host: input.host, port: input.port, login: input.login };
  assert.equal((await call(alice.cookie, "PUT", "/proxies/profile.one", withoutPassword)).status, 200);
  const switched = await call(alice.cookie, "PUT", "/proxies/profile.one", { ...withoutPassword, protocol: "socks5" });
  assert.equal(switched.status, 200);
  assert.equal(switched.data.protocol, "socks5");
  const retained = await prisma.accountProxy.findUniqueOrThrow({ where: { id: stored.id } });
  assert.equal(retained.protocol, "socks5");
  assert.equal(decryptToken(retained.password), input.password);
  assert.equal((await call(alice.cookie, "PUT", "/proxies/profile.one", { ...withoutPassword, protocol: "invalid" })).status, 400);
  assert.equal((await call(alice.cookie, "PUT", "/proxies/profile.one", { ...withoutPassword, port: 8001 })).status, 400);
  const release = holdProxy({ userId: alice.id, username: "profile.one" });
  try {
    assert.equal((await call(alice.cookie, "DELETE", "/proxies/profile.one")).status, 409);
    assert.equal((await call(alice.cookie, "PUT", "/proxies/profile.one", input)).status, 409);
  } finally { release(); }
  assert.equal((await call(alice.cookie, "DELETE", "/proxies/profile.one")).status, 204);
  assert.equal((await call(alice.cookie, "POST", "/connect", { username: "profile.one" })).status, 409);
  console.log("PASS: Supabase persistence, encryption, duplicate/racing assignments, ownership, password retention, active-window protection, CORS and missing-proxy login blocking.");

  if (process.env.VERIFY_PROXY_HOST && process.env.VERIFY_PROXY_LOGIN && process.env.VERIFY_PROXY_PASSWORD) {
    const credentials = { protocol: process.env.VERIFY_PROXY_PROTOCOL ?? "http", host: process.env.VERIFY_PROXY_HOST, port: Number(process.env.VERIFY_PROXY_PORT), login: process.env.VERIFY_PROXY_LOGIN, password: process.env.VERIFY_PROXY_PASSWORD };
    assert.equal((await call(alice.cookie, "PUT", "/proxies/live.proxy.check", credentials)).status, 200);
    const result = await call(alice.cookie, "POST", "/proxies/live.proxy.check/check");
    if (result.status !== 200) throw new Error(result.data.error);
    assert.notEqual(result.data.directIp, result.data.exitIp);
    console.log(JSON.stringify({ liveProxy: "verified", directIp: result.data.directIp, exitIp: result.data.exitIp, threadsLoginLoaded: true, accountSignedIn: false }));
  }
} finally {
  await browserSessions.shutdown();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const id of created) await prisma.user.deleteMany({ where: { id } });
  await prisma.$disconnect();
  console.log("Temporary verification users, sessions and proxy assignments removed.");
}

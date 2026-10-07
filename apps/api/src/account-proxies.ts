import { isIPv4 } from "node:net";
import { request, type APIResponse, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { z } from "zod";
import type { AccountProxy as DbProxy } from "@prisma/client";
import type { AccountProxy } from "@threadflow/shared";
import { prisma } from "./db.js";
import { HttpError } from "./http.js";
import { decryptToken, encryptToken } from "./security.js";
import { createThreadsBrowser, type BrowserStorageState } from "./browser-sessions.js";
import { config } from "./config.js";
import { proxyLocalAddress, startSocksProxy } from "./socks-proxy.js";

export type ProxyOwner = { userId: string; username: string };
export function publicIPv4(ip: string): boolean {
  if (!isIPv4(ip)) return false;
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) ||
    (a === 198 && (b === 18 || b === 19)));
}
export const proxyInputSchema = z.object({
  protocol: z.enum(["http", "socks5"]).optional(),
  host: z.string().trim().refine(publicIPv4, "Enter a public IPv4 proxy address."),
  port: z.number().int().min(1).max(65535),
  login: z.string().trim().min(1).max(256).refine((value) => !/[\r\n\0]/.test(value)),
  password: z.string().min(1).max(1024).refine((value) => !/[\r\n\0]/.test(value)).optional(),
}).strict();

export function publicProxy(proxy: DbProxy): AccountProxy {
  return { username: proxy.username, protocol: proxy.protocol as AccountProxy["protocol"], host: proxy.host, port: proxy.port, login: proxy.login,
    hasPassword: true, status: proxy.status as AccountProxy["status"],
    checkedAt: proxy.checkedAt?.toISOString() ?? null, directIp: proxy.directIp,
    exitIp: proxy.exitIp, error: proxy.error };
}

// This desktop backend owns its browser processes. Hold a read lease for the
// entire browser lifetime so settings cannot change underneath an open session.
const readers = new Map<string, number>();
const writers = new Set<string>();
const keyOf = (owner: ProxyOwner) => `${owner.userId}:${owner.username}`;
export function holdProxy(owner: ProxyOwner): () => void {
  const key = keyOf(owner);
  if (writers.has(key)) throw new HttpError(409, "Proxy settings are being changed. Try again shortly.");
  readers.set(key, (readers.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (readers.get(key) ?? 1) - 1;
    if (remaining) readers.set(key, remaining); else readers.delete(key);
  };
}
export async function editProxy<T>(owner: ProxyOwner, operation: () => Promise<T>): Promise<T> {
  const key = keyOf(owner);
  if (writers.has(key) || readers.has(key))
    throw new HttpError(409, "Close this account’s Threads windows and wait for publication or proxy checks to finish before changing its proxy.");
  writers.add(key);
  try { return await operation(); } finally { writers.delete(key); }
}
export async function saveProxy(owner: ProxyOwner, body: unknown): Promise<AccountProxy> {
  const input = proxyInputSchema.parse(body);
  return editProxy(owner, async () => {
    const existing = await prisma.accountProxy.findUnique({ where: { userId_username: owner } });
    const protocol = input.protocol ?? existing?.protocol ?? "http";
    if (!input.password && (!existing || existing.host !== input.host || existing.port !== input.port || existing.login !== input.login))
      throw new HttpError(400, "Enter the proxy password when adding a proxy or changing its address or login.");
    const duplicate = await prisma.accountProxy.findFirst({ where: {
      userId: owner.userId, host: input.host, port: input.port, username: { not: owner.username },
    } });
    if (duplicate) throw new HttpError(409, `This proxy is already assigned to @${duplicate.username}. Each account needs its own proxy.`);
    if (protocol === "socks5" && (Buffer.byteLength(input.login) > 255 || (input.password && Buffer.byteLength(input.password) > 255)))
      throw new HttpError(400, "SOCKS5 login and password must each fit within 255 bytes.");
    const data = { protocol, host: input.host, port: input.port, login: input.login,
      password: input.password ? encryptToken(input.password) : existing!.password,
      status: "unchecked", checkedAt: null, directIp: null, exitIp: null, error: null };
    try {
      return publicProxy(await prisma.accountProxy.upsert({ where: { userId_username: owner }, create: { ...owner, ...data }, update: data }));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "P2002")
        throw new HttpError(409, "This proxy was just assigned to another account. Choose a different proxy.");
      throw error;
    }
  });
}

const IP_URL = "https://api.ipify.org/?format=json";
export function proxyCheckFailure(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const message = error instanceof Error ? error.message : "";
  if (/ERR_INVALID_AUTH_CREDENTIALS|ERR_PROXY_AUTH_UNSUPPORTED|ERR_PROXY_AUTH_REQUESTED|407/.test(message))
    return new HttpError(502, "The proxy rejected authentication. Check its login and password. Threads was not opened.");
  if (/timeout|timed out/i.test(message))
    return new HttpError(502, "The proxy did not complete the HTTPS IP check within 20 seconds. Check the proxy’s availability and your VPN/network route. A wrong password has not been confirmed. Threads was not opened.");
  if (/ERR_PROXY_CONNECTION_FAILED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_TUNNEL_CONNECTION_FAILED/.test(message))
    return new HttpError(502, "Could not establish a connection through the proxy. Check its address, port and your VPN/network route. Threads was not opened.");
  return new HttpError(502, "The proxy did not return a valid HTTPS IP-check response. Threads was not opened; try the check again.");
}
export function requireDifferentIP(directIp: string, exitIp: string): void {
  if (!publicIPv4(directIp) || !publicIPv4(exitIp))
    throw new HttpError(502, "The external IPv4 check returned an invalid address. Threads was not opened.");
  if (directIp === exitIp)
    throw new HttpError(502, "Proxy IP matches the backend’s direct IP. Threads was not opened.");
}
export async function readDirectIP(): Promise<string> {
  const direct = await request.newContext({ timeout: 15_000 });
  try {
    for (const url of [IP_URL, "https://checkip.amazonaws.com/"]) {
      try {
        const response = await direct.get(url, { maxRedirects: 0 });
        if (!response.ok()) continue;
        const ip = url === IP_URL
          ? z.object({ ip: z.string() }).parse(await response.json()).ip
          : (await response.text()).trim();
        if (publicIPv4(ip)) return ip;
      } catch { /* A blocked IP service must not disable a working proxy. */ }
    }
    throw new HttpError(502, "Both services for checking the backend’s direct IP are unavailable. Threads was not opened.");
  } finally { await direct.dispose(); }
}
export async function checkBrowserIP(context: BrowserContext, directIP: () => Promise<string> = readDirectIP): Promise<{ directIp: string; exitIp: string }> {
  // No Threads/Instagram navigation (including popups) is permitted until the
  // fixed proxy's HTTPS path and the backend's direct path have been compared.
  const guard = (route: Route) => route.request().url() === IP_URL ? route.continue() : route.abort();
  await context.route("**/*", guard);
  try {
    const results = await Promise.allSettled([
      directIP(),
      // The context request client inherits this browser's fixed proxy. No
      // diagnostic page is created in the user's login window.
      context.request.get(IP_URL, { timeout: 20_000, maxRedirects: 0 }).then(async (response) => {
        if (response.status() === 407) throw new Error("407 proxy authentication failed");
        if (!response.ok() || response.url() !== IP_URL) throw new Error("Proxy IP check failed");
        return z.object({ ip: z.string() }).parse(await response.json()).ip;
      }),
    ]);
    const [directResult, proxyResult] = results;
    if (directResult.status === "rejected") throw new HttpError(502, "Could not determine the backend’s direct IP. Threads was not opened; try the proxy check again.");
    if (proxyResult.status === "rejected") throw proxyCheckFailure(proxyResult.reason);
    requireDifferentIP(directResult.value, proxyResult.value);
    await context.unroute("**/*", guard);
    return { directIp: directResult.value, exitIp: proxyResult.value };
  } catch (error) { throw proxyCheckFailure(error); }
}

const THREADS_LOGIN = "https://www.threads.com/login";
export function requireThreadsResponse(response: Pick<APIResponse, "status" | "url" | "headers"> | null): void {
  if (!response) throw new HttpError(502, "The proxy returned no response from Threads.");
  const host = new URL(response.url()).hostname;
  if (!["www.threads.com", "threads.com", "www.threads.net", "threads.net"].includes(host) ||
      response.status() < 200 || response.status() >= 400 || !response.headers()["content-type"]?.includes("text/html"))
    throw new HttpError(502, `The proxy reached a server, but Threads did not return its page (HTTP ${response.status()}).`);
}
function threadsCheckFailure(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const message = error instanceof Error ? error.message : "";
  const reason = /RESET|ECONNRESET/i.test(message) ? "the connection was reset" :
    /timeout|timed out/i.test(message) ? "the page timed out" : "the page could not be loaded";
  return new HttpError(502, `Proxy IP verified, but Threads is unavailable: ${reason}. Check the proxy protocol and VPN route. No account was connected.`);
}

export async function waitForThreadsInterface(page: Page, timeout = 30_000): Promise<void> {
  try {
    await page.waitForFunction(() => {
      const controls = document.querySelectorAll('input[type="password"],input[autocomplete="one-time-code"],input[name*="verification"],nav a[href],[role="navigation"] a[href]');
      if (Array.from(controls).some((element) => element.getClientRects().length > 0)) return true;
      return Array.from(document.querySelectorAll('button,[role="button"],a[href],h1,h2,[role="heading"]')).some((element) =>
        element.getClientRects().length > 0 && /log in|sign in|continue with instagram|войти|вход|продолжить.*instagram|security code|confirm your identity|account.*suspended/i.test(element.textContent ?? ""));
    }, undefined, { timeout });
  } catch {
    throw new HttpError(502, "Proxy IP verified and Threads responded, but its login interface did not load. Some Threads/Instagram resources may be blocked or interrupted on this proxy route. No account was connected.");
  }
}

export async function recheckProxyContext(owner: ProxyOwner, context: BrowserContext): Promise<void> {
  let result: { directIp: string; exitIp: string } | undefined;
  try {
    result = await checkBrowserIP(context);
    try { requireThreadsResponse(await context.request.get(THREADS_LOGIN, { timeout: 30_000 })); }
    catch (error) { throw threadsCheckFailure(error); }
    await prisma.accountProxy.update({ where: { userId_username: owner }, data: { ...result, status: "verified", checkedAt: new Date(), error: null } });
  } catch (error) {
    const message = error instanceof HttpError ? error.userMessage : "Proxy verification failed. The Threads window was closed.";
    await context.browser()?.close().catch(() => undefined);
    await prisma.accountProxy.updateMany({ where: owner, data: { status: "failed", checkedAt: new Date(), directIp: result?.directIp ?? null, exitIp: result?.exitIp ?? null, error: message } }).catch(() => undefined);
    throw new HttpError(502, message);
  }
}

export async function openProxyContext(owner: ProxyOwner | undefined, headless: boolean, storageState?: BrowserStorageState): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  if (!owner) throw new HttpError(409, "Assign a proxy to this account before opening Threads.");
  const release = holdProxy(owner);
  let browser: Browser | undefined;
  let proxy: DbProxy | null = null;
  let bridge: Awaited<ReturnType<typeof startSocksProxy>> | undefined;
  let result: { directIp: string; exitIp: string } | undefined;
  try {
    proxy = await prisma.accountProxy.findUnique({ where: { userId_username: owner } });
    if (!proxy) throw new HttpError(409, `Add a proxy for @${owner.username} before opening Threads.`);
    const password = decryptToken(proxy.password);
    if (proxy.protocol === "socks5")
      bridge = await startSocksProxy({ ...proxy, password }, proxyLocalAddress(config.PROXY_NETWORK_INTERFACE));
    const credentials = bridge?.proxy ?? { server: `http://${proxy.host}:${proxy.port}`, username: proxy.login, password };
    browser = await createThreadsBrowser({ headless, proxy: credentials });
    browser.on("disconnected", release);
    browser.on("disconnected", () => { void bridge?.close(); });
    const context = await browser.newContext({ storageState, locale: "en-US", viewport: { width: 1280, height: 860 }, serviceWorkers: "block" });
    result = await checkBrowserIP(context);
    const page = await context.newPage();
    try {
      requireThreadsResponse(await page.goto(storageState ? "https://www.threads.com/" : THREADS_LOGIN, { waitUntil: "domcontentloaded", timeout: 45_000 }));
      await waitForThreadsInterface(page);
    } catch (error) { throw threadsCheckFailure(error); }
    await prisma.accountProxy.update({ where: { id: proxy.id }, data: { ...result, checkedAt: new Date(), status: "verified", error: null } });
    return { browser, context, page };
  } catch (error) {
    const message = bridge?.failure() ?? (error instanceof HttpError ? error.userMessage : "Could not verify the proxy. Threads was not opened. Check the proxy settings and connection.");
    if (proxy) await prisma.accountProxy.updateMany({ where: { id: proxy.id }, data: { status: "failed", checkedAt: new Date(), directIp: result?.directIp ?? null, exitIp: result?.exitIp ?? null, error: message } }).catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await bridge?.close();
    release();
    throw new HttpError(error instanceof HttpError ? error.status : 502, message);
  }
}
export async function checkSavedProxy(owner: ProxyOwner): Promise<AccountProxy> {
  const { browser } = await openProxyContext(owner, true);
  await browser.close();
  return publicProxy(await prisma.accountProxy.findUniqueOrThrow({ where: { userId_username: owner } }));
}

import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { z } from "zod";
import type { SocialAccount as DbAccount } from "@prisma/client";
import type { BrowserConnection, BrowserProfile, ProviderInfo, SessionVerification, SocialAccount } from "@threadflow/shared";
import { prisma } from "./db.js";
import { HttpError } from "./http.js";
import { decryptToken, encryptToken } from "./security.js";
import { publicAccount } from "./serialize.js";
import { openProxyContext, recheckProxyContext, type ProxyOwner } from "./account-proxies.js";

const LOGIN_URL = "https://www.threads.com/login";
const HOME_URL = "https://www.threads.com/";
const CONNECTION_TTL = 15 * 60_000;
const storedSessionSchema = z.object({
  version: z.literal(1),
  storageState: z.object({
    cookies: z.array(z.object({
      name: z.string(), value: z.string(), domain: z.string().refine(storageDomain), path: z.string(),
      expires: z.number().finite(), httpOnly: z.boolean(), secure: z.boolean(), sameSite: z.enum(["Strict", "Lax", "None"]),
    })),
    origins: z.array(z.object({
      origin: z.string().url().refine((origin) => { const url = new URL(origin); return url.protocol === "https:" && storageDomain(url.hostname); }),
      localStorage: z.array(z.object({ name: z.string(), value: z.string() })),
      indexedDB: z.array(z.unknown()).optional(),
    }).passthrough()),
  }),
});
export type BrowserStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
type BrowserProviderInfo = Extract<ProviderInfo, { provider: "browser" }>;
type Owner = { userId: string; sessionId: string };
type VerificationStatus = SessionVerification["status"];
type VerificationFailure = Exclude<VerificationStatus, "verified">;
export interface BrowserIdentity {
  id: string;
  username: string;
  expiresAt: Date | null;
}
export interface VerifiedBrowserSession {
  identity: BrowserIdentity;
  storageState: BrowserStorageState;
}
export type BrowserInspection =
  | { status: "verified"; identity: BrowserIdentity }
  | { status: VerificationFailure; errorMessage: string };
export class SessionAuthenticationError extends HttpError {
  constructor(public readonly verification: BrowserInspection) {
    super(409, verification.status === "verified" ? "Session verified." : verification.errorMessage);
  }
}
export interface SessionWindow {
  checkProxy(): Promise<void>;
  inspect(expected?: BrowserIdentity): Promise<BrowserInspection>;
  snapshot(): Promise<BrowserStorageState>;
  verify(state: BrowserStorageState, expected: BrowserIdentity): Promise<VerifiedBrowserSession>;
  close(): Promise<void>;
  onClose(callback: () => void): void;
}
interface PendingConnection extends Owner {
  id: string;
  status: BrowserConnection["status"];
  expiresAt: number;
  reconnectId?: string;
  expectedId?: string;
  expectedUsername: string;
  window?: SessionWindow;
  account?: SocialAccount;
  profile?: BrowserProfile;
  errorMessage?: string;
}
interface OpenWindow extends Owner {
  accountId: string;
  accessToken: string | null;
  identity: BrowserIdentity;
  lastStatus: VerificationStatus;
  lastCheckedAt: number;
  window: SessionWindow;
}
interface SessionDependencies {
  launch(state?: BrowserStorageState, owner?: ProxyOwner): Promise<SessionWindow>;
  verifyState(state: BrowserStorageState, expected: BrowserIdentity, owner?: ProxyOwner): Promise<VerifiedBrowserSession>;
  persist(owner: Owner, session: VerifiedBrowserSession, reconnectId?: string, expectedToken?: string | null): Promise<SocialAccount>;
  recordVerification(owner: Owner, accountId: string, inspection: BrowserInspection, expectedToken?: string | null): Promise<void>;
  readAccount(account: Pick<DbAccount, "id" | "userId">): Promise<DbAccount | null>;
  now(): number;
}

export function normalizeUsername(value: string): string {
  return z.string().trim().transform((username) => username.replace(/^@/, "").toLowerCase())
    .pipe(z.string().regex(/^[a-z0-9._]{1,30}$/, "Enter the exact Threads username, without a profile URL."))
    .parse(value);
}

function threadsDomain(host: string): boolean {
  return /(^|\.)threads\.(com|net)$/i.test(host.replace(/^\./, ""));
}
function storageDomain(host: string): boolean {
  return threadsDomain(host) || /(^|\.)instagram\.com$/i.test(host.replace(/^\./, ""));
}
export function profileUsername(href: string): string | null {
  try {
    const url = new URL(href, HOME_URL);
    if (!threadsDomain(url.hostname) || url.protocol !== "https:") return null;
    return /^\/@([a-zA-Z0-9._]{1,30})\/?$/.exec(url.pathname)?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}
export function authenticatedCookies(state: BrowserStorageState, now = Date.now()): { id: string; expiresAt: Date | null } | null {
  const valid = state.cookies.filter((cookie) => threadsDomain(cookie.domain) && cookie.value && (cookie.expires === -1 || cookie.expires * 1000 > now));
  for (const session of valid.filter((cookie) => cookie.name === "sessionid")) {
    const user = valid.find((cookie) => cookie.name === "ds_user_id" && cookie.domain === session.domain && /^\d+$/.test(cookie.value));
    if (user) return { id: user.value, expiresAt: session.expires > 0 ? new Date(session.expires * 1000) : null };
  }
  return null;
}
export function filterSessionStorage(state: BrowserStorageState): BrowserStorageState {
  return {
    cookies: state.cookies.filter((cookie) => storageDomain(cookie.domain)),
    origins: state.origins.filter((origin) => {
      try { const url = new URL(origin.origin); return url.protocol === "https:" && storageDomain(url.hostname); }
      catch { return false; }
    }),
  };
}
export function decodeBrowserSessionJSON(decryptedJSON: string): BrowserStorageState {
  return storedSessionSchema.parse(JSON.parse(decryptedJSON)).storageState as BrowserStorageState;
}
export function decodeBrowserSession(encrypted: string): BrowserStorageState {
  return decodeBrowserSessionJSON(decryptToken(encrypted));
}

function browserCandidates(): Array<{ channel?: "msedge" | "chrome"; path: string }> {
  const candidates: Array<{ channel?: "msedge" | "chrome"; path: string }> = [];
  if (process.platform === "win32") {
    const directories = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter((value): value is string => Boolean(value));
    for (const directory of directories) candidates.push({ channel: "msedge", path: join(directory, "Microsoft", "Edge", "Application", "msedge.exe") });
    for (const directory of directories) candidates.push({ channel: "chrome", path: join(directory, "Google", "Chrome", "Application", "chrome.exe") });
  }
  candidates.push({ path: chromium.executablePath() });
  return candidates.filter((candidate, index) => existsSync(candidate.path) && candidates.findIndex((other) => other.path === candidate.path) === index);
}
export function browserConfiguration(): BrowserProviderInfo {
  const configured = browserCandidates().length > 0;
  return { provider: "browser", configured, loginUrl: LOGIN_URL, missing: configured ? [] : ["Install Microsoft Edge or Google Chrome, or run npm run browser:install."] };
}

interface PageAuthenticationEvidence {
  url: string;
  profileHref: string | null;
  challenge: boolean;
  blocked: boolean;
  loginForm: boolean;
}
async function pageAuthenticationEvidence(page: Page): Promise<PageAuthenticationEvidence> {
  return page.evaluate(() => {
    const text = Array.from(document.querySelectorAll('h1,h2,[role="heading"],form'))
      .filter((element) => {
        if (!element.getClientRects().length || element.closest('article,[role="article"],[data-pressable-container]')) return false;
        const dialog = element.closest('[role="dialog"]');
        return !element.querySelector('[contenteditable="true"]') && !dialog?.querySelector('[contenteditable="true"]');
      })
      .map((element) => element.textContent ?? "").join(" ");
    const url = window.location.href;
    const challenge = /\/(challenge|checkpoint|two_factor|confirm_email|confirm_phone)(\/|\?|$)/i.test(url)
      || Array.from(document.querySelectorAll('input[autocomplete="one-time-code"],input[name*="verification"],input[name*="security_code"],input[name*="confirmation_code"]')).some((element) => element.getClientRects().length > 0)
      || /enter (?:the |a )?(?:security |confirmation |verification )?code|security code|check your (?:phone|email)|код подтверждения|введите код|подтвердите (?:свою личность|вход)|подтверждение входа/i.test(text);
    const blocked = /\/(suspended|disabled|blocked|captcha)(\/|\?|$)/i.test(url)
      || /account (?:has been )?(?:suspended|disabled)|your account is (?:suspended|disabled)|unusual activity|temporarily blocked|аккаунт (?:заблокирован|приостановлен)|учетная запись (?:заблокирована|приостановлена)|необычн(?:ая|ую) активность|подтвердите, что вы человек/i.test(text);
    const loginForm = Array.from(document.querySelectorAll('input[type="password"],input[autocomplete="current-password"]')).some((element) => element.getClientRects().length > 0)
      || (/\/(login|accounts\/login)\/?(?:\?|$)/i.test(url) && /log in|sign in|войти|вход/i.test(text));
    const labels = /^(?:your )?profile$|^(профиль|профіль|профил|個人檔案|个人档案|プロフィール|プロファイル|프로필|perfil|profil|profilo)$/i;
    const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"));
    let profileHref: string | null = null;
    for (const anchor of anchors) {
      if (anchor.closest('article,[role="article"]') || !anchor.getClientRects().length) continue;
      const labelled = [anchor.getAttribute("aria-label"), anchor.querySelector("svg")?.getAttribute("aria-label"), anchor.querySelector("svg title")?.textContent].some((label) => labels.test(label?.trim() ?? ""));
      const navigation = anchor.closest('nav,[role="navigation"],header,sidebar');
      const inNavigation = Boolean(navigation?.querySelector('a[href="/"]') && navigation.querySelector('a[href="/search"],a[href="/activity"]'));
      if (labelled || inNavigation) {
        const url = new URL(anchor.href, window.location.href);
        if (/^\/@[a-zA-Z0-9._]{1,30}\/?$/.test(url.pathname)) {
          profileHref = url.href;
          break;
        }
      }
    }
    return { url, profileHref, challenge, blocked, loginForm };
  });
}
export function classifyAuthentication(evidence: PageAuthenticationEvidence, cookies: ReturnType<typeof authenticatedCookies>, expected?: BrowserIdentity): BrowserInspection {
  let host: string;
  try { host = new URL(evidence.url).hostname; }
  catch { return { status: "unknown", errorMessage: "The browser is not on the Threads login page." }; }
  if (!storageDomain(host)) return { status: "unknown", errorMessage: "The browser is not on Threads or Instagram. Open Threads to confirm the login." };
  if (evidence.blocked) return { status: "blocked", errorMessage: "Threads or Instagram has blocked this login. Resolve the check in the browser before connecting." };
  if (evidence.challenge) return { status: "challenge", errorMessage: "Complete the SMS, email or security confirmation in the browser. The account is not connected yet." };
  if (evidence.loginForm) return { status: "expired", errorMessage: "Threads requires you to sign in again. Finish the login in the browser." };
  const username = evidence.profileHref && profileUsername(evidence.profileHref);
  if (!threadsDomain(host) || !cookies || !username) return { status: "unknown", errorMessage: "The signed-in Threads profile is not confirmed. Wait for the page to load or open your profile in Threads." };
  const identity = { ...cookies, username };
  if (expected && (identity.id !== expected.id || identity.username !== expected.username))
    return { status: "mismatch", errorMessage: `Threads opened @${identity.username}, but this connection belongs to @${expected.username}. Switch to the correct profile.` };
  return { status: "verified", identity };
}
export async function inspectBrowserContext(context: BrowserContext, expected?: BrowserIdentity): Promise<BrowserInspection> {
  const cookies = authenticatedCookies(await context.storageState());
  let found: BrowserInspection = { status: "unknown", errorMessage: "Threads has not confirmed the signed-in profile yet." };
  let instagramCheck: BrowserInspection | undefined;
  for (const page of context.pages().reverse()) {
    if (page.isClosed()) continue;
    let host: string;
    try { host = new URL(page.url()).hostname; } catch { continue; }
    if (!storageDomain(host)) continue;
    const evidence = await pageAuthenticationEvidence(page);
    const inspection = classifyAuthentication(evidence, threadsDomain(host) ? cookies : null, expected);
    if (["challenge", "blocked", "expired", "mismatch"].includes(inspection.status)) {
      if (threadsDomain(host)) return inspection;
      instagramCheck = inspection;
    }
    if (inspection.status === "verified") found = inspection;
  }
  return found.status === "verified" ? found : instagramCheck ?? found;
}
export async function createThreadsBrowser(options: { headless: boolean; proxy?: { server: string; username: string; password: string } }): Promise<Browser> {
  const candidates = browserCandidates();
  if (!candidates.length) throw new HttpError(503, browserConfiguration().missing[0] ?? "Install a browser first.");
  for (const candidate of candidates) {
    try {
      return await chromium.launch({ headless: options.headless, proxy: options.proxy, args: options.proxy ? ["--disable-quic", "--proxy-bypass-list=<-loopback>", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] : [], channel: candidate.channel, executablePath: candidate.channel ? undefined : candidate.path });
    } catch { /* Try the next installed browser without exposing its process output. */ }
  }
  throw new HttpError(503, "Could not open a browser. Run the backend on this computer and try again.");
}
async function inspectLoadedContext(context: BrowserContext, expected?: BrowserIdentity): Promise<BrowserInspection> {
  let inspection = await inspectBrowserContext(context, expected);
  for (let attempt = 0; inspection.status === "unknown" && attempt < 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    inspection = await inspectBrowserContext(context, expected);
  }
  return inspection;
}
async function verifyRestoredSession(storageState: BrowserStorageState, expected: BrowserIdentity, owner?: ProxyOwner): Promise<VerifiedBrowserSession> {
  if (!authenticatedCookies(storageState))
    throw new SessionAuthenticationError({ status: "expired", errorMessage: "The saved Threads cookie has expired. Reconnect the profile." });
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let stage: RestorationStage = "browser";
  try {
    ({ browser, context } = await openProxyContext(owner, true, storageState));
    stage = "identity";
    const inspection = await inspectLoadedContext(context, expected);
    if (inspection.status !== "verified") throw new SessionAuthenticationError(inspection);
    stage = "storage";
    return { identity: inspection.identity, storageState: filterSessionStorage(await context.storageState({ indexedDB: true })) };
  } catch (error) {
    if (error instanceof SessionAuthenticationError) throw error;
    throw new SessionAuthenticationError(restorationFailure(stage, error));
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}
type RestorationStage = "browser" | "context" | "page" | "navigation" | "identity" | "storage";
export function restorationFailure(stage: RestorationStage, error: unknown): BrowserInspection {
  if (error instanceof HttpError) return { status: "unknown", errorMessage: error.userMessage };
  if (stage === "navigation") return navigationFailure(error);
  const messages: Record<Exclude<RestorationStage, "navigation">, string> = {
    browser: "The browser could not start for session verification. Check the installed browser and backend permissions.",
    context: "The saved browser storage could not be restored. Reconnect the Threads profile to save a fresh session.",
    page: "The browser could not create a page for session verification. Try again or restart the backend.",
    identity: "Threads loaded, but its signed-in profile could not be inspected. Open the profile manually and complete any login checks.",
    storage: "Threads confirmed the profile, but its refreshed session could not be captured. Try verification again.",
  };
  return { status: "unknown", errorMessage: messages[stage] };
}
export function navigationFailure(error: unknown): BrowserInspection {
  const message = error instanceof Error ? error.message : "";
  if (/ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_INTERNET_DISCONNECTED|ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED/i.test(message))
    return { status: "unknown", errorMessage: "Threads could not be reached. Check the internet, DNS or proxy connection and try verification again." };
  if (/timeout|timed out/i.test(message))
    return { status: "unknown", errorMessage: "Threads did not finish loading in time. The session remains saved; try verification again." };
  return { status: "unknown", errorMessage: "Threads could not be opened for session verification. The session remains saved; try again or reconnect." };
}
async function launchSessionWindow(state?: BrowserStorageState, owner?: ProxyOwner): Promise<SessionWindow> {
  const { browser: launchedBrowser, context } = await openProxyContext(owner, false, state);
  try {
    return {
      inspect: (expected) => inspectBrowserContext(context, expected),
      snapshot: async () => filterSessionStorage(await context.storageState({ indexedDB: true })),
      verify: (storage, identity) => verifyRestoredSession(storage, identity, owner),
      checkProxy: () => recheckProxyContext(owner!, context),
      close: () => launchedBrowser.close(),
      onClose: (callback) => {
        launchedBrowser.once("disconnected", callback);
        context.once("close", callback);
        const watchPage = (openPage: Page) => openPage.once("close", () => {
          if (!context.pages().length) {
            callback();
            void launchedBrowser.close().catch(() => undefined);
          }
        });
        context.on("page", watchPage);
        context.pages().forEach(watchPage);
      },
    };
  } catch {
    await launchedBrowser.close().catch(() => undefined);
    throw new HttpError(503, "Could not create the browser login window. Run the backend on this desktop and try again.");
  }
}

async function persistSession(owner: Owner, session: VerifiedBrowserSession, reconnectId?: string, expectedToken?: string | null): Promise<SocialAccount> {
  const activeSession = await prisma.session.findFirst({ where: { id: owner.sessionId, userId: owner.userId, expiresAt: { gt: new Date() } } });
  if (!activeSession) throw new HttpError(401, "Your platform session has expired. Sign in and reconnect the account.");
  if (reconnectId) {
    const original = await prisma.socialAccount.findFirst({ where: { id: reconnectId, userId: owner.userId, provider: "browser" } });
    if (!original || original.providerAccountId !== session.identity.id)
      throw new HttpError(409, "Sign in to the same Threads profile to reconnect. Use Connect account to add another profile.");
  }
  const data = {
    username: session.identity.username,
    displayName: session.identity.username,
    avatarUrl: null,
    status: "connected",
    accessToken: encryptToken(JSON.stringify({ version: 1, storageState: session.storageState })),
    refreshToken: null,
    tokenExpiresAt: session.identity.expiresAt,
    sessionVerifiedAt: new Date(),
    sessionVerificationStatus: "verified",
    sessionVerificationError: null,
  };
  if (reconnectId && expectedToken !== undefined) {
    const updated = await prisma.socialAccount.updateMany({
      where: { id: reconnectId, userId: owner.userId, provider: "browser", providerAccountId: session.identity.id, accessToken: expectedToken, status: { not: "disconnected" } },
      data,
    });
    if (!updated.count) throw new HttpError(409, "The saved Threads session changed during verification. Check the profile again.");
    const account = await prisma.socialAccount.findUniqueOrThrow({ where: { id: reconnectId } });
    return publicAccount(account);
  }
  const account = await prisma.socialAccount.upsert({
    where: { userId_provider_providerAccountId: { userId: owner.userId, provider: "browser", providerAccountId: session.identity.id } },
    create: { userId: owner.userId, provider: "browser", providerAccountId: session.identity.id, ...data },
    update: data,
  });
  return publicAccount(account);
}

export class BrowserSessionManager {
  private readonly connections = new Map<string, PendingConnection>();
  private readonly opened = new Map<string, OpenWindow>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly cleanup: ReturnType<typeof setInterval>;
  private stopped = false;
  constructor(private readonly dependencies: SessionDependencies) {
    this.cleanup = setInterval(() => {
      void this.expire().catch(() => undefined);
      void this.checkOpenWindows().catch(() => undefined);
    }, 10_000);
    this.cleanup.unref();
  }
  private async locked<T>(userId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(userId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.locks.set(userId, current);
    try { return await current; }
    finally { if (this.locks.get(userId) === current) this.locks.delete(userId); }
  }
  private owned(owner: Owner, id: string): PendingConnection {
    const connection = this.connections.get(id);
    if (!connection || connection.userId !== owner.userId || connection.sessionId !== owner.sessionId)
      throw new HttpError(404, "Connection not found. Start a new connection from this window.");
    return connection;
  }
  private publicConnection(connection: PendingConnection): BrowserConnection {
    return { id: connection.id, status: connection.status, expectedUsername: connection.expectedUsername, expiresAt: new Date(connection.expiresAt).toISOString(), ...(connection.account ? { account: connection.account } : {}), ...(connection.profile ? { profile: connection.profile } : {}), ...(connection.errorMessage ? { errorMessage: connection.errorMessage } : {}) };
  }
  private async finish(connection: PendingConnection, status: BrowserConnection["status"]): Promise<void> {
    connection.status = status;
    const window = connection.window;
    connection.window = undefined;
    await window?.close().catch(() => undefined);
  }
  private async ensureActive(connection: PendingConnection): Promise<boolean> {
    if (["saved", "cancelled", "expired", "failed"].includes(connection.status)) return false;
    if (this.stopped) {
      await this.finish(connection, "cancelled");
      return false;
    }
    if (connection.expiresAt <= this.dependencies.now()) {
      await this.finish(connection, "expired");
      return false;
    }
    return true;
  }
  async start(owner: Owner, reconnect?: { id: string; providerAccountId: string }, expectedUsername?: string): Promise<BrowserConnection> {
    const username = normalizeUsername(expectedUsername ?? "");
    return this.locked(owner.userId, async () => {
      if (this.stopped) throw new HttpError(503, "The backend is restarting. Try again shortly.");
      for (const previous of this.connections.values())
        if (previous.userId === owner.userId && await this.ensureActive(previous)) await this.finish(previous, "cancelled");
      const connection: PendingConnection = { ...owner, id: randomUUID(), status: "waiting", expiresAt: this.dependencies.now() + CONNECTION_TTL, reconnectId: reconnect?.id, expectedId: reconnect?.providerAccountId, expectedUsername: username };
      this.connections.set(connection.id, connection);
      try {
        connection.window = await this.dependencies.launch(undefined, { userId: owner.userId, username });
        connection.window.onClose(() => {
          if (!["saved", "cancelled", "expired", "failed"].includes(connection.status)) {
            connection.status = "cancelled";
            connection.window = undefined;
          }
        });
      } catch (error) {
        connection.status = "failed";
        connection.errorMessage = error instanceof HttpError ? error.userMessage : "Could not open the Threads login window. Try again.";
        if (error instanceof HttpError) throw error;
        throw new HttpError(503, connection.errorMessage);
      }
      return this.publicConnection(connection);
    });
  }
  async get(owner: Owner, id: string): Promise<BrowserConnection> {
    return this.locked(owner.userId, async () => {
      const connection = this.owned(owner, id);
      if (await this.ensureActive(connection)) {
        try {
          if (connection.window) this.connectionInspection(connection, await connection.window.inspect());
        } catch {
          connection.status = "unknown";
          connection.profile = undefined;
          connection.errorMessage = "The Threads page is still loading. Finish signing in, then try again.";
        }
      }
      return this.publicConnection(connection);
    });
  }
  private connectionInspection(connection: PendingConnection, inspection: BrowserInspection): void {
    if (inspection.status !== "verified") {
      connection.status = inspection.status === "expired" ? "waiting" : inspection.status;
      connection.profile = undefined;
      connection.errorMessage = inspection.errorMessage;
      return;
    }
    const identity = inspection.identity;
    connection.profile = { id: identity.id, username: identity.username, displayName: identity.username, avatarUrl: null };
    if (identity.username !== connection.expectedUsername || (connection.expectedId && identity.id !== connection.expectedId)) {
      connection.status = "mismatch";
      connection.errorMessage = `Threads opened @${identity.username}; sign in to @${connection.expectedUsername} before saving.`;
      return;
    }
    connection.status = "ready";
    connection.errorMessage = undefined;
  }
  async save(owner: Owner, id: string, confirmedUsername: string): Promise<BrowserConnection> {
    return this.locked(owner.userId, async () => {
      const connection = this.owned(owner, id);
      if (normalizeUsername(confirmedUsername) !== connection.expectedUsername)
        throw new HttpError(409, "Confirm the exact Threads username selected for this connection before saving.");
      if (connection.status === "saved") return this.publicConnection(connection);
      if (!await this.ensureActive(connection) || !connection.window)
        throw new HttpError(409, "This login window has closed or expired. Start a new connection.");
      const inspection = await connection.window.inspect();
      this.connectionInspection(connection, inspection);
      if (inspection.status !== "verified" || connection.status !== "ready")
        throw new HttpError(409, connection.errorMessage ?? "Finish the Threads login before saving.");
      const identity = inspection.identity;
      if (normalizeUsername(confirmedUsername) !== identity.username)
        throw new HttpError(409, "Confirm the exact Threads username shown in this connection before saving.");
      let verified: VerifiedBrowserSession;
      try {
        verified = await connection.window.verify(await connection.window.snapshot(), identity);
        if (verified.identity.id !== identity.id || verified.identity.username !== identity.username)
          throw new SessionAuthenticationError({ status: "mismatch", errorMessage: "The restored session opened a different Threads profile. Switch to the correct profile before saving." });
      } catch (error) {
        if (error instanceof SessionAuthenticationError) {
          this.connectionInspection(connection, error.verification);
          throw error;
        }
        connection.status = "unknown";
        connection.errorMessage = "Could not confirm the restored Threads login. The login window remains open; complete all checks and try again.";
        throw new HttpError(502, connection.errorMessage);
      }
      if (!await this.ensureActive(connection) || !connection.window)
        throw new HttpError(409, "This login window has expired. Start a new connection.");
      connection.account = await this.dependencies.persist(owner, verified, connection.reconnectId);
      connection.status = "saved";
      const window = connection.window;
      connection.window = undefined;
      await this.keepWindow(owner, connection.account.id, window, verified.identity);
      return this.publicConnection(connection);
    });
  }
  async cancel(owner: Owner, id: string): Promise<BrowserConnection> {
    return this.locked(owner.userId, async () => {
      const connection = this.owned(owner, id);
      if (await this.ensureActive(connection)) await this.finish(connection, "cancelled");
      return this.publicConnection(connection);
    });
  }
  async open(owner: Owner, account: DbAccount): Promise<void> {
    await this.locked(owner.userId, async () => {
      if (this.stopped) throw new HttpError(503, "The backend is restarting. Try again shortly.");
      const current = await this.dependencies.readAccount(account);
      if (!current) throw new HttpError(404, "Saved Threads profile not found.");
      account = current;
      if (account.userId !== owner.userId || account.provider !== "browser" || account.status === "disconnected" || !account.accessToken)
        throw new HttpError(409, "Reconnect this Threads profile before opening it.");
      let state: BrowserStorageState;
      try {
        state = decodeBrowserSession(account.accessToken);
      } catch { throw new HttpError(409, "This saved session could not be restored. Reconnect the profile."); }
      if (!authenticatedCookies(state, this.dependencies.now())) {
        await this.dependencies.recordVerification(owner, account.id, { status: "expired", errorMessage: "This Threads session has expired. Reconnect the profile." }, account.accessToken);
        throw new HttpError(409, "This Threads session has expired. Reconnect the profile.");
      }
      const existing = this.opened.get(account.id);
      if (existing) {
        if (existing.accessToken !== account.accessToken)
          throw new HttpError(409, "The saved session was updated. Close the existing Threads window, then open the profile again.");
        existing.sessionId = owner.sessionId;
        await existing.window.checkProxy();
        await this.checkWindow(existing);
        return;
      }
      const window = await this.dependencies.launch(state, { userId: owner.userId, username: account.username });
      const identity: BrowserIdentity = { id: account.providerAccountId, username: account.username, expiresAt: account.tokenExpiresAt };
      await this.keepWindow(owner, account.id, window, identity);
      const opened = this.opened.get(account.id);
      if (opened) await this.checkWindow(opened);
    });
  }
  private async keepWindow(owner: Owner, accountId: string, window: SessionWindow, identity: BrowserIdentity): Promise<void> {
    const old = this.opened.get(accountId);
    if (old && old.window !== window) await old.window.close().catch(() => undefined);
    const current = await this.dependencies.readAccount({ id: accountId, userId: owner.userId });
    const opened: OpenWindow = { ...owner, accountId, accessToken: current?.accessToken ?? null, identity, lastStatus: "verified", lastCheckedAt: 0, window };
    this.opened.set(accountId, opened);
    window.onClose(() => { if (this.opened.get(accountId) === opened) this.opened.delete(accountId); });
  }
  private async checkWindow(opened: OpenWindow): Promise<BrowserInspection> {
    let inspection: BrowserInspection;
    try { inspection = await opened.window.inspect(opened.identity); }
    catch { inspection = { status: "unknown", errorMessage: "The Threads session could not be checked. Check the connection and try again." }; }
    if (inspection.status === "verified" && (inspection.identity.id !== opened.identity.id || inspection.identity.username !== opened.identity.username))
      inspection = { status: "mismatch", errorMessage: "The browser switched to another Threads profile. Reconnect the intended profile." };
    if (this.opened.get(opened.accountId) === opened && (inspection.status !== opened.lastStatus || this.dependencies.now() - opened.lastCheckedAt > 60_000)) {
      await this.dependencies.recordVerification(opened, opened.accountId, inspection, opened.accessToken);
      opened.lastStatus = inspection.status;
      opened.lastCheckedAt = this.dependencies.now();
    }
    return inspection;
  }
  async checkOpenWindows(): Promise<void> {
    for (const opened of this.opened.values()) await this.locked(opened.userId, () => this.checkWindow(opened));
  }
  async verify(owner: Owner, account: DbAccount): Promise<SessionVerification> {
    return this.locked(owner.userId, async () => {
      const current = await this.dependencies.readAccount(account);
      if (!current) throw new HttpError(404, "Saved Threads profile not found.");
      account = current;
      if (account.userId !== owner.userId || account.provider !== "browser") throw new HttpError(404, "Saved Threads profile not found.");
      const opened = this.opened.get(account.id);
      let inspection: BrowserInspection;
      if (opened && opened.accessToken === account.accessToken) {
        await opened.window.checkProxy();
        inspection = await this.checkWindow(opened);
      }
      else if (account.status === "disconnected" || !account.accessToken)
        inspection = { status: "expired", errorMessage: "This Threads profile is disconnected. Reconnect it first." };
      else {
        try {
          const state = decodeBrowserSession(account.accessToken);
          const expected = { id: account.providerAccountId, username: account.username, expiresAt: account.tokenExpiresAt };
          if (!authenticatedCookies(state, this.dependencies.now()))
            inspection = { status: "expired", errorMessage: "This Threads session has expired. Reconnect the profile." };
          else {
            const session = await this.dependencies.verifyState(state, expected, { userId: owner.userId, username: account.username });
            if (session.identity.id !== expected.id || session.identity.username !== expected.username)
              throw new SessionAuthenticationError({ status: "mismatch", errorMessage: "The saved session opened another Threads profile. Reconnect the correct profile." });
            await this.dependencies.persist(owner, session, account.id, account.accessToken);
            inspection = { status: "verified", identity: session.identity };
          }
        } catch (error) {
          inspection = error instanceof SessionAuthenticationError ? error.verification : { status: "unknown", errorMessage: "Could not check the saved Threads session. Check the connection and try again." };
        }
      }
      if (inspection.status !== "verified")
        await this.dependencies.recordVerification(owner, account.id, inspection, account.accessToken);
      return { status: inspection.status, checkedAt: new Date(this.dependencies.now()).toISOString(), ...(inspection.status === "verified" ? { profile: { id: inspection.identity.id, username: inspection.identity.username, displayName: inspection.identity.username, avatarUrl: null } } : { errorMessage: inspection.errorMessage }) };
    });
  }
  async disconnectAccount(userId: string, accountId: string, disconnect?: () => Promise<void>): Promise<void> {
    await this.locked(userId, async () => {
      await disconnect?.();
      for (const connection of this.connections.values())
        if (connection.userId === userId && connection.reconnectId === accountId && await this.ensureActive(connection)) await this.finish(connection, "cancelled");
      const opened = this.opened.get(accountId);
      if (opened?.userId === userId) {
        this.opened.delete(accountId);
        await opened.window.close().catch(() => undefined);
      }
    });
  }
  async closePlatformSession(sessionId: string): Promise<void> {
    for (const connection of this.connections.values())
      if (connection.sessionId === sessionId) await this.locked(connection.userId, async () => {
        if (await this.ensureActive(connection)) await this.finish(connection, "cancelled");
      });
    for (const [accountId, opened] of this.opened)
      if (opened.sessionId === sessionId) await this.locked(opened.userId, async () => {
        if (this.opened.get(accountId) === opened) {
          this.opened.delete(accountId);
          await opened.window.close().catch(() => undefined);
        }
      });
  }
  async expire(): Promise<void> {
    for (const connection of this.connections.values()) {
      if (connection.expiresAt <= this.dependencies.now()) {
        await this.locked(connection.userId, () => this.ensureActive(connection));
        if (connection.expiresAt + CONNECTION_TTL <= this.dependencies.now() && !connection.window) this.connections.delete(connection.id);
      }
    }
  }
  async shutdown(): Promise<void> {
    this.stopped = true;
    clearInterval(this.cleanup);
    await Promise.allSettled(this.locks.values());
    await Promise.allSettled([...this.connections.values()].map((connection) => this.finish(connection, connection.status === "saved" ? "saved" : "cancelled")));
    await Promise.allSettled([...this.opened.values()].map((opened) => opened.window.close()));
    this.connections.clear();
    this.opened.clear();
  }
}

export const browserSessions = new BrowserSessionManager({
  launch: launchSessionWindow,
  verifyState: verifyRestoredSession,
  persist: persistSession,
  readAccount: (account) => prisma.socialAccount.findFirst({ where: { id: account.id, userId: account.userId, provider: "browser" } }),
  recordVerification: async (owner, accountId, inspection, expectedToken) => {
    await prisma.socialAccount.updateMany({
      where: { id: accountId, userId: owner.userId, provider: "browser", status: { not: "disconnected" }, ...(expectedToken === undefined ? {} : { accessToken: expectedToken }) },
      data: {
        sessionVerificationStatus: inspection.status,
        sessionVerificationError: inspection.status === "verified" ? null : inspection.errorMessage,
        sessionVerifiedAt: inspection.status === "verified" ? new Date() : null,
        ...(inspection.status === "unknown" ? {} : { status: inspection.status === "verified" ? "connected" : "expired" }),
      },
    });
  },
  now: Date.now,
});
export const closeSessionBrowsers = () => browserSessions.shutdown();

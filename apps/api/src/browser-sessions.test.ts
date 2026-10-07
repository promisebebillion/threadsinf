import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import type { BrowserContext } from "playwright";
import type { SocialAccount as DbAccount } from "@prisma/client";
import type { SocialAccount } from "@threadflow/shared";
import {
  authenticatedCookies,
  BrowserSessionManager,
  classifyAuthentication,
  inspectBrowserContext,
  navigationFailure,
  restorationFailure,
  SessionAuthenticationError,
  filterSessionStorage,
  profileUsername,
  type BrowserIdentity,
  type BrowserInspection,
  type BrowserStorageState,
  type SessionWindow,
} from "./browser-sessions.js";
import { encryptToken } from "./security.js";

const owner = { userId: "test-owner", sessionId: "test-platform-session" };
const identity: BrowserIdentity = { id: "123456", username: "own.profile", expiresAt: null };
const account: SocialAccount = {
  id: "saved-profile",
  provider: "browser",
  providerAccountId: identity.id,
  username: identity.username,
  displayName: identity.username,
  avatarUrl: null,
  status: "connected",
  tokenExpiresAt: null,
  createdAt: new Date().toISOString(),
  sessionVerifiedAt: new Date().toISOString(),
  sessionVerificationStatus: "verified",
  sessionVerificationError: null,
};
const cookie = (name: string, value: string, domain = ".threads.com", expires = -1) => ({ name, value, domain, expires, path: "/", httpOnly: true, secure: true, sameSite: "Lax" as const });
const state = (): BrowserStorageState => ({ cookies: [cookie("sessionid", "test-only-cookie"), cookie("ds_user_id", identity.id)], origins: [] });
const encryptedState = encryptToken(JSON.stringify({ version: 1, storageState: state() }));

class TestWindow implements SessionWindow {
  async checkProxy() {}
  current: BrowserIdentity | null = identity;
  restored: BrowserIdentity | null = identity;
  closed = 0;
  verified = 0;
  savedState = state();
  inspectionError?: Error;
  result?: BrowserInspection;
  restoreResult?: BrowserInspection;
  closeCallback?: () => void;
  async inspect() {
    if (this.inspectionError) throw this.inspectionError;
    return this.result ?? (this.current ? { status: "verified" as const, identity: this.current } : { status: "unknown" as const, errorMessage: "Profile not confirmed" });
  }
  async snapshot() { return this.savedState; }
  async verify() {
    this.verified++;
    if (this.restoreResult) throw new SessionAuthenticationError(this.restoreResult);
    if (!this.restored) throw new SessionAuthenticationError({ status: "unknown", errorMessage: "Restore failed" });
    return { identity: this.restored, storageState: this.savedState };
  }
  async close() { this.closed++; this.closeCallback?.(); }
  onClose(callback: () => void) { this.closeCallback = callback; }
}
function harness() {
  let clock = Date.now();
  const windows: TestWindow[] = [];
  const proxyOwners: Array<{ userId: string; username: string }> = [];
  const persisted: Array<{ userId: string; accountId?: string; storageState: BrowserStorageState }> = [];
  const expired: string[] = [];
  const verifications: BrowserInspection[] = [];
  let setup: (window: TestWindow) => void = () => undefined;
  let currentAccount: DbAccount | null | undefined;
  const manager = new BrowserSessionManager({
    now: () => clock,
    readAccount: async (reference) => {
      if (currentAccount !== undefined) return currentAccount;
      if ("accessToken" in reference) return reference as DbAccount;
      return { ...storedAccount(), ...reference };
    },
    launch: async (_state, proxyOwner) => { assert.ok(proxyOwner); proxyOwners.push(proxyOwner); const window = new TestWindow(); setup(window); windows.push(window); return window; },
    verifyState: async (_state, _expected, proxyOwner) => {
      assert.deepEqual(proxyOwner, { userId: owner.userId, username: identity.username });
      const window = new TestWindow();
      setup(window);
      return window.verify();
    },
    persist: async (savedOwner, session, accountId) => {
      persisted.push({ userId: savedOwner.userId, accountId, storageState: session.storageState });
      return account;
    },
    recordVerification: async (_savedOwner, accountId, inspection) => {
      verifications.push(inspection);
      if (inspection.status === "expired") expired.push(accountId);
    },
  });
  return { manager, windows, proxyOwners, persisted, expired, verifications, setAccount: (account: DbAccount | null) => { currentAccount = account; }, setup: (callback: typeof setup) => { setup = callback; }, advance: (milliseconds: number) => { clock += milliseconds; } };
}
function storedAccount(savedState = state()): DbAccount {
  return {
    ...account,
    userId: owner.userId,
    accessToken: JSON.stringify(savedState) === JSON.stringify(state()) ? encryptedState : encryptToken(JSON.stringify({ version: 1, storageState: savedState })),
    refreshToken: null,
    tokenExpiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    sessionVerifiedAt: new Date(),
  };
}

test("only Threads root profile links can identify the signed-in profile", () => {
  assert.equal(profileUsername("/@My.Profile"), "my.profile");
  assert.equal(profileUsername("https://www.threads.net/@own_profile/"), "own_profile");
  assert.equal(profileUsername("https://attacker.example/@own.profile"), null);
  assert.equal(profileUsername("https://threads.com.attacker.example/@own.profile"), null);
  assert.equal(profileUsername("/@own.profile/post/123"), null);
  assert.equal(profileUsername("https://www.threads.com/login"), null);
});
test("Instagram cookies and expired or incomplete Threads cookies do not prove Threads login", () => {
  assert.equal(authenticatedCookies({ cookies: [cookie("sessionid", "value", ".instagram.com"), cookie("ds_user_id", "123456", ".instagram.com")], origins: [] }), null);
  assert.equal(authenticatedCookies({ cookies: [cookie("sessionid", "value")], origins: [] }), null);
  assert.equal(authenticatedCookies({ cookies: [cookie("sessionid", "value", ".threads.com", 1), cookie("ds_user_id", "123456")], origins: [] }), null);
  assert.equal(authenticatedCookies({ cookies: [cookie("sessionid", "value"), cookie("ds_user_id", "not-a-user-id")], origins: [] }), null);
  assert.deepEqual(authenticatedCookies(state()), { id: identity.id, expiresAt: null });
});
test("persisted browser state excludes unrelated websites and preserves Threads and Instagram storage", () => {
  const input: BrowserStorageState = {
    cookies: [...state().cookies, cookie("ig", "value", ".instagram.com"), cookie("foreign", "private", ".attacker.example")],
    origins: [
      { origin: "https://www.threads.com", localStorage: [{ name: "setting", value: "saved" }] },
      { origin: "https://www.instagram.com", localStorage: [] },
      { origin: "https://threads.com.attacker.example", localStorage: [{ name: "secret", value: "private" }] },
    ],
  };
  const filtered = filterSessionStorage(input);
  assert.equal(filtered.cookies.length, 3);
  assert.equal(filtered.origins.length, 2);
  assert.equal(filtered.origins[0]?.localStorage[0]?.value, "saved");
});
test("pending login is inaccessible to another user or another platform session", async () => {
  const h = harness();
  try {
    const connection = await h.manager.start(owner, undefined, identity.username);
    await assert.rejects(h.manager.get({ ...owner, userId: "other-user" }, connection.id), { status: 404 });
    await assert.rejects(h.manager.save({ ...owner, sessionId: "other-session" }, connection.id, identity.username), { status: 404 });
    await assert.rejects(h.manager.cancel({ ...owner, userId: "other-user" }, connection.id), { status: 404 });
    assert.equal(h.windows[0]?.closed, 0);
  } finally { await h.manager.shutdown(); }
});
test("another login attempt closes the old window and accounts can be connected separately", async () => {
  const h = harness();
  try {
    const first = await h.manager.start(owner, undefined, identity.username);
    const second = await h.manager.start(owner, undefined, identity.username);
    assert.equal((await h.manager.get(owner, first.id)).status, "cancelled");
    assert.equal(h.windows[0]?.closed, 1);
    assert.equal((await h.manager.get(owner, second.id)).status, "ready");
    await h.manager.start({ userId: "another-user", sessionId: "another-session" }, undefined, identity.username);
    assert.equal(h.windows[1]?.closed, 0);
    assert.deepEqual(h.proxyOwners, [
      { userId: owner.userId, username: identity.username },
      { userId: owner.userId, username: identity.username },
      { userId: "another-user", username: identity.username },
    ]);
  } finally { await h.manager.shutdown(); }
});
test("login without a confirmed live self profile cannot be saved", async () => {
  const h = harness();
  h.setup((window) => { window.current = null; });
  try {
    const connection = await h.manager.start(owner, undefined, identity.username);
    assert.equal((await h.manager.get(owner, connection.id)).status, "unknown");
    await assert.rejects(h.manager.save(owner, connection.id, identity.username), { status: 409 });
    assert.equal(h.persisted.length, 0);
  } finally { await h.manager.shutdown(); }
});
test("confirmed self profile is previewed without returning cookies or inventing a persisted account", async () => {
  const h = harness();
  try {
    const connection = await h.manager.start(owner, undefined, identity.username);
    const ready = await h.manager.get(owner, connection.id);
    assert.equal(ready.status, "ready");
    assert.equal(ready.profile?.username, identity.username);
    assert.equal(ready.account, undefined);
    assert.ok(!JSON.stringify(ready).includes("test-only-cookie"));
  } finally { await h.manager.shutdown(); }
});
test("save validates a fresh restoration before persistence and leaves the manual login window open", async () => {
  const h = harness();
  try {
    const connection = await h.manager.start(owner, undefined, identity.username);
    const saved = await h.manager.save(owner, connection.id, identity.username);
    assert.equal(saved.status, "saved");
    assert.equal(saved.account?.id, account.id);
    assert.equal(h.windows[0]?.verified, 1);
    assert.equal(h.persisted.length, 1);
    assert.equal(h.windows[0]?.closed, 0);
    await h.manager.save(owner, connection.id, identity.username);
    assert.equal(h.persisted.length, 1);
    assert.ok(!JSON.stringify(saved).includes("test-only-cookie"));
  } finally { await h.manager.shutdown(); }
});
test("a restored session for a different profile is never persisted", async () => {
  const h = harness();
  h.setup((window) => { window.restored = { ...identity, id: "999999", username: "other.profile" }; });
  try {
    const connection = await h.manager.start(owner, undefined, identity.username);
    await assert.rejects(h.manager.save(owner, connection.id, identity.username), { status: 409 });
    assert.equal(h.persisted.length, 0);
  } finally { await h.manager.shutdown(); }
});
test("reconnection cannot silently replace the saved profile with another identity", async () => {
  const h = harness();
  try {
    const connection = await h.manager.start(owner, { id: account.id, providerAccountId: "different-profile" }, identity.username);
    await assert.rejects(h.manager.save(owner, connection.id, identity.username), { status: 409 });
    assert.equal(h.persisted.length, 0);
  } finally { await h.manager.shutdown(); }
});
test("expired and cancelled connection windows close and cannot later save", async () => {
  const h = harness();
  try {
    const connection = await h.manager.start(owner, undefined, identity.username);
    h.advance(15 * 60_000 + 1);
    await h.manager.expire();
    assert.equal((await h.manager.get(owner, connection.id)).status, "expired");
    assert.equal(h.windows[0]?.closed, 1);
    await assert.rejects(h.manager.save(owner, connection.id, identity.username), { status: 409 });
    const another = await h.manager.start(owner, undefined, identity.username);
    assert.equal((await h.manager.cancel(owner, another.id)).status, "cancelled");
    await assert.rejects(h.manager.save(owner, another.id, identity.username), { status: 409 });
  } finally { await h.manager.shutdown(); }
});
test("closing the real login window makes the pending connection cancelled", async () => {
  const h = harness();
  try {
    const connection = await h.manager.start(owner, undefined, identity.username);
    await h.windows[0]?.close();
    assert.equal((await h.manager.get(owner, connection.id)).status, "cancelled");
    await assert.rejects(h.manager.save(owner, connection.id, identity.username), { status: 409 });
  } finally { await h.manager.shutdown(); }
});
test("a saved encrypted session reopens separately and disconnect closes its window", async () => {
  const h = harness();
  try {
    await h.manager.open(owner, storedAccount());
    assert.equal(h.verifications[0]?.status, "verified");
    let cleared = false;
    await h.manager.disconnectAccount(owner.userId, account.id, async () => { cleared = true; });
    assert.equal(cleared, true);
    assert.equal(h.windows[0]?.closed, 1);
  } finally { await h.manager.shutdown(); }
});
test("expired cookie sessions are marked expired without opening a browser", async () => {
  const h = harness();
  try {
    const expiredState = state();
    expiredState.cookies[0]!.expires = 1;
    await assert.rejects(h.manager.open(owner, storedAccount(expiredState)), { status: 409 });
    assert.deepEqual(h.expired, [account.id]);
    assert.equal(h.windows.length, 0);
  } finally { await h.manager.shutdown(); }
});
test("reopening a saved session validates the same live self profile", async () => {
  const h = harness();
  h.setup((window) => { window.current = { ...identity, id: "other-profile" }; });
  try {
    await h.manager.open(owner, storedAccount());
    assert.equal(h.persisted.length, 0);
    assert.equal(h.verifications[0]?.status, "mismatch");
    assert.equal(h.windows[0]?.closed, 0);
  } finally { await h.manager.shutdown(); }
});
test("shutdown closes active windows and forbids new starts", async () => {
  const h = harness();
  await h.manager.start(owner, undefined, identity.username);
  await h.manager.open(owner, storedAccount());
  await h.manager.shutdown();
  assert.equal(h.windows[0]?.closed, 1);
  assert.equal(h.windows[1]?.closed, 1);
  await assert.rejects(h.manager.start(owner, undefined, identity.username), { status: 503 });
});
test("logging out closes the platform session's login and reopened windows", async () => {
  const h = harness();
  try {
    const connection = await h.manager.start(owner, undefined, identity.username);
    await h.manager.open(owner, storedAccount());
    await h.manager.closePlatformSession(owner.sessionId);
    assert.equal((await h.manager.get(owner, connection.id)).status, "cancelled");
    assert.equal(h.windows[0]?.closed, 1);
    assert.equal(h.windows[1]?.closed, 1);
  } finally { await h.manager.shutdown(); }
});
test("a temporary browser inspection failure does not expire the saved session", async () => {
  const h = harness();
  h.setup((window) => { window.inspectionError = new Error("Temporary page failure"); });
  try {
    await h.manager.open(owner, storedAccount());
    assert.equal(h.expired.length, 0);
    assert.equal(h.persisted.length, 0);
    assert.equal(h.verifications[0]?.status, "unknown");
    assert.equal(h.windows[0]?.closed, 0);
  } finally { await h.manager.shutdown(); }
});
test("malformed encrypted state is rejected before passing cookies to a browser", async () => {
  const h = harness();
  try {
    const saved = storedAccount();
    saved.accessToken = encryptToken(JSON.stringify({ version: 1, storageState: { cookies: [{ name: "sessionid", value: "private-cookie" }], origins: [] } }));
    await assert.rejects(h.manager.open(owner, saved), { status: 409 });
    assert.equal(h.windows.length, 0);
    assert.equal(h.expired.length, 0);
  } finally { await h.manager.shutdown(); }
});
test("SMS challenge and blocked login override stale authenticated cookies and profile links", () => {
  const evidence = { url: "https://www.threads.com/", profileHref: "https://www.threads.com/@own.profile", challenge: true, blocked: false, loginForm: false };
  const cookies = authenticatedCookies(state());
  assert.equal(classifyAuthentication(evidence, cookies).status, "challenge");
  assert.equal(classifyAuthentication({ ...evidence, challenge: false, blocked: true }, cookies).status, "blocked");
  assert.equal(classifyAuthentication({ ...evidence, challenge: false, loginForm: true }, cookies).status, "expired");
  assert.equal(classifyAuthentication({ ...evidence, challenge: false, url: "https://attacker.example/" }, cookies).status, "unknown");
});
test("matching numeric cookie identity still rejects the wrong Threads child username", async () => {
  const h = harness();
  h.setup((window) => { window.current = { ...identity, username: "wrong.child" }; });
  try {
    const connection = await h.manager.start(owner, undefined, identity.username);
    const result = await h.manager.get(owner, connection.id);
    assert.equal(result.status, "mismatch");
    assert.equal(result.expectedUsername, identity.username);
    assert.equal(result.profile?.username, "wrong.child");
    await assert.rejects(h.manager.save(owner, connection.id, "wrong.child"), { status: 409 });
    assert.equal(h.persisted.length, 0);
    assert.equal(h.windows[0]?.closed, 0);
  } finally { await h.manager.shutdown(); }
});
test("manual profile confirmation is required before saving", async () => {
  const h = harness();
  try {
    const connection = await h.manager.start(owner, undefined, identity.username);
    await assert.rejects(h.manager.save(owner, connection.id, "another.profile"), { status: 409 });
    assert.equal(h.persisted.length, 0);
    assert.equal(h.windows[0]?.closed, 0);
  } finally { await h.manager.shutdown(); }
});
test("an SMS checkpoint never becomes connected and its manual window stays open", async () => {
  const h = harness();
  h.setup((window) => { window.result = { status: "challenge", errorMessage: "SMS required" }; });
  try {
    const connection = await h.manager.start(owner, undefined, identity.username);
    assert.equal((await h.manager.get(owner, connection.id)).status, "challenge");
    await assert.rejects(h.manager.save(owner, connection.id, identity.username), { status: 409 });
    assert.equal(h.persisted.length, 0);
    assert.equal(h.windows[0]?.closed, 0);
    h.windows[0]!.result = { status: "verified", identity };
    assert.equal((await h.manager.get(owner, connection.id)).status, "ready");
  } finally { await h.manager.shutdown(); }
});
test("a checkpoint in fresh restoration prevents saving while retaining the manual login window", async () => {
  const h = harness();
  h.setup((window) => { window.restoreResult = { status: "challenge", errorMessage: "Confirmation required" }; });
  try {
    const connection = await h.manager.start(owner, undefined, identity.username);
    await assert.rejects(h.manager.save(owner, connection.id, identity.username), { status: 409 });
    assert.equal(h.persisted.length, 0);
    assert.equal(h.windows[0]?.closed, 0);
  } finally { await h.manager.shutdown(); }
});
test("repeated status polling leaves the same manual window open", async () => {
  const h = harness();
  try {
    const connection = await h.manager.start(owner, undefined, identity.username);
    await h.manager.get(owner, connection.id);
    await h.manager.get(owner, connection.id);
    await h.manager.get(owner, connection.id);
    assert.equal(h.windows.length, 1);
    assert.equal(h.windows[0]?.closed, 0);
    assert.equal(h.windows[0]?.verified, 0);
  } finally { await h.manager.shutdown(); }
});
test("saved and reopened windows do not automatically close after the login-attempt TTL", async () => {
  const h = harness();
  try {
    const connection = await h.manager.start(owner, undefined, identity.username);
    await h.manager.save(owner, connection.id, identity.username);
    h.advance(16 * 60_000);
    await h.manager.expire();
    await h.manager.open(owner, storedAccount());
    assert.equal(h.windows.length, 1);
    assert.equal(h.windows[0]?.closed, 0);
  } finally { await h.manager.shutdown(); }
});
test("read-only monitoring records actual logout and checkpoints without closing the window", async () => {
  const h = harness();
  try {
    await h.manager.open(owner, storedAccount());
    h.windows[0]!.result = { status: "expired", errorMessage: "Logged out" };
    await h.manager.checkOpenWindows();
    assert.equal(h.verifications.at(-1)?.status, "expired");
    h.windows[0]!.result = { status: "challenge", errorMessage: "SMS required" };
    await h.manager.checkOpenWindows();
    assert.equal(h.verifications.at(-1)?.status, "challenge");
    assert.equal(h.windows[0]?.closed, 0);
    assert.equal(h.windows.length, 1);
  } finally { await h.manager.shutdown(); }
});
test("saved-session verification checks restoration without opening a visible login window", async () => {
  const h = harness();
  try {
    const verified = await h.manager.verify(owner, storedAccount());
    assert.equal(verified.status, "verified");
    assert.equal(verified.profile?.username, identity.username);
    assert.equal(h.windows.length, 0);
    assert.ok(!JSON.stringify(verified).includes("test-only-cookie"));
  } finally { await h.manager.shutdown(); }
});
test("saved-session verification preserves genuine challenge and unknown outcomes", async () => {
  const h = harness();
  h.setup((window) => { window.restoreResult = { status: "challenge", errorMessage: "SMS required" }; });
  try {
    const result = await h.manager.verify(owner, storedAccount());
    assert.equal(result.status, "challenge");
    assert.equal(h.persisted.length, 0);
    assert.equal(h.windows.length, 0);
  } finally { await h.manager.shutdown(); }
});
test("saved connections still require the originally confirmed username on repeated saves", async () => {
  const h = harness();
  try {
    const connection = await h.manager.start(owner, undefined, identity.username);
    await h.manager.save(owner, connection.id, identity.username);
    await assert.rejects(h.manager.save(owner, connection.id, "another.profile"), { status: 409 });
    assert.equal(h.persisted.length, 1);
    assert.equal(h.windows[0]?.closed, 0);
  } finally { await h.manager.shutdown(); }
});
test("an old connected row cannot restore an account disconnected while its request was waiting", async () => {
  const h = harness();
  const old = storedAccount();
  h.setAccount({ ...old, status: "disconnected", accessToken: null });
  try {
    await assert.rejects(h.manager.open(owner, old), { status: 409 });
    assert.equal(h.windows.length, 0);
    assert.equal(h.persisted.length, 0);
    assert.equal((await h.manager.verify(owner, old)).status, "expired");
  } finally { await h.manager.shutdown(); }
});
test("closing a saved browser during a status check never marks its stored session logged out", async () => {
  const h = harness();
  h.setup((window) => {
    window.inspect = async () => {
      await window.close();
      return { status: "unknown", errorMessage: "Window closed" };
    };
  });
  try {
    await h.manager.open(owner, storedAccount());
    assert.equal(h.verifications.length, 0);
    assert.equal(h.persisted.length, 0);
  } finally { await h.manager.shutdown(); }
});
test("navigation diagnostics preserve unknown status and never expose raw browser URLs or cookies", () => {
  const network = navigationFailure(new Error("page.goto net::ERR_NAME_NOT_RESOLVED https://www.threads.com/?private=secret-cookie"));
  const timeout = navigationFailure(new Error("Timeout 45000 ms exceeded private-cookie"));
  const generic = navigationFailure(new Error("Unexpected payload secret-cookie"));
  assert.equal(network.status, "unknown");
  assert.equal(timeout.status, "unknown");
  assert.equal(generic.status, "unknown");
  assert.ok(!JSON.stringify([network, timeout, generic]).includes("secret-cookie"));
});
test("a manual login window with a navigation failure stays open and can still be cancelled", async () => {
  const h = harness();
  h.setup((window) => { window.result = navigationFailure(new Error("net::ERR_CONNECTION_RESET private-cookie")); });
  try {
    const connection = await h.manager.start(owner, undefined, identity.username);
    const result = await h.manager.get(owner, connection.id);
    assert.equal(result.status, "unknown");
    assert.ok(!JSON.stringify(result).includes("private-cookie"));
    assert.equal(h.windows[0]?.closed, 0);
    await h.manager.cancel(owner, connection.id);
    assert.equal(h.windows[0]?.closed, 1);
  } finally { await h.manager.shutdown(); }
});
test("restoration failures identify the safe failing stage without exposing private storage", () => {
  const privateError = new Error("private-cookie encrypted-token https://www.threads.com/?secret=secret");
  const context = restorationFailure("context", privateError);
  const browser = restorationFailure("browser", privateError);
  const identity = restorationFailure("identity", privateError);
  assert.equal(context.status, "unknown");
  assert.equal(browser.status, "unknown");
  assert.equal(identity.status, "unknown");
  assert.match(JSON.stringify(context), /storage could not be restored/);
  assert.match(JSON.stringify(browser), /browser could not start/);
  assert.match(JSON.stringify(identity), /profile could not be inspected/);
  assert.ok(!JSON.stringify([context, browser, identity]).includes("private-cookie"));
});
interface BrowserPageFixture {
  url: string;
  username?: string;
  challenge?: boolean;
  login?: boolean;
  composerText?: string;
}
function browserContextFixture(fixtures: BrowserPageFixture[]): BrowserContext {
  return {
    storageState: async () => state(),
    pages: () => fixtures.map((fixture) => ({
      isClosed: () => false,
      url: () => fixture.url,
      evaluate: async (callback: () => unknown) => {
        const profile = {
          href: `https://www.threads.com/@${fixture.username}`,
          getClientRects: () => [{}],
          closest: () => null,
          getAttribute: (name: string) => name === "aria-label" ? "Profile" : null,
          querySelector: () => null,
        };
        const composerDialog = { querySelector: () => ({}) };
        const composerHeading = {
          textContent: fixture.composerText,
          getClientRects: () => [{}],
          closest: (selector: string) => selector === '[role="dialog"]' ? composerDialog : null,
          querySelector: () => null,
        };
        const visibleInput = { getClientRects: () => [{}] };
        const document = {
          querySelectorAll: (selector: string) => {
            if (selector === "a[href]") return fixture.username ? [profile] : [];
            if (selector.includes('autocomplete="one-time-code"')) return fixture.challenge ? [visibleInput] : [];
            if (selector.includes('input[type="password"]')) return fixture.login ? [visibleInput] : [];
            return fixture.composerText ? [composerHeading] : [];
          },
        };
        return runInNewContext(`(${callback.toString()})()`, { document, window: { location: { href: fixture.url } }, URL });
      },
    })),
  } as unknown as BrowserContext;
}
test("the real inspection callback survives serialization in a browser without Node or tsx helpers", async () => {
  const context = browserContextFixture([{ url: "https://www.threads.com/", username: identity.username }]);
  const result = await inspectBrowserContext(context, identity);
  assert.deepEqual(result, { status: "verified", identity });
});
test("composer text about verification codes never becomes a login checkpoint", async () => {
  const context = browserContextFixture([{ url: "https://www.threads.com/", username: identity.username, composerText: "Security code, check your email, unusual activity" }]);
  const result = await inspectBrowserContext(context, identity);
  assert.equal(result.status, "verified");
});
test("a stale Instagram login tab does not override a genuine verified Threads page", async () => {
  const context = browserContextFixture([
    { url: "https://www.threads.com/", username: identity.username },
    { url: "https://www.instagram.com/accounts/login/", login: true },
  ]);
  assert.equal((await inspectBrowserContext(context, identity)).status, "verified");
});
test("a genuine Threads checkpoint overrides any stale profile link and valid cookies", async () => {
  const context = browserContextFixture([{ url: "https://www.threads.com/challenge/", username: identity.username, challenge: true }]);
  assert.equal((await inspectBrowserContext(context, identity)).status, "challenge");
});
test("a newer saved session stays unverified when it rotates after successful verification persistence", async () => {
  let saved = storedAccount();
  const originalToken = saved.accessToken;
  const manager = new BrowserSessionManager({
    now: Date.now,
    readAccount: async () => saved,
    launch: async () => { throw new Error("This check must not open a visible browser"); },
    verifyState: async () => ({ identity, storageState: state() }),
    persist: async (_owner, _session, _accountId, expectedToken) => {
      assert.equal(expectedToken, originalToken);
      saved = {
        ...saved,
        accessToken: encryptToken(JSON.stringify({ version: 1, storageState: state() })),
        sessionVerificationStatus: "unknown",
        sessionVerifiedAt: null,
      };
      return account;
    },
    recordVerification: async (_owner, _accountId, inspection, expectedToken) => {
      if (expectedToken === undefined || expectedToken === saved.accessToken)
        saved = { ...saved, sessionVerificationStatus: inspection.status, sessionVerifiedAt: inspection.status === "verified" ? new Date() : null };
    },
  });
  try {
    assert.equal((await manager.verify(owner, saved)).status, "verified");
    assert.notEqual(saved.accessToken, originalToken);
    assert.equal(saved.sessionVerificationStatus, "unknown");
    assert.equal(saved.sessionVerifiedAt, null);
  } finally { await manager.shutdown(); }
});

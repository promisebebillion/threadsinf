import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  BrowserThreadsProvider,
  collectProfilePosts,
  type BrowserPostObservation,
  type BrowserPublishInput,
  type PublishingWindow,
} from "./browser-publishing.js";
import { createThreadsBrowser } from "./browser-sessions.js";
import type { BrowserIdentity, BrowserStorageState } from "./browser-sessions.js";
import { ProviderError } from "./providers.js";

const clock = Date.parse("2026-10-05T10:00:00.000Z");
const identity: BrowserIdentity = { id: "123456", username: "own.profile", expiresAt: null };
const state: BrowserStorageState = {
  cookies: [
    { name: "sessionid", value: "unit-test-only", domain: ".threads.com", path: "/", expires: -1, secure: true, httpOnly: true, sameSite: "Lax" },
    { name: "ds_user_id", value: identity.id, domain: ".threads.com", path: "/", expires: -1, secure: true, httpOnly: false, sameSite: "Lax" },
  ],
  origins: [],
};
const savedSession = JSON.stringify({ version: 1, storageState: state });
const content = "A real account publishes this exact text\nwith two lines.";

function post(overrides: Partial<BrowserPostObservation> = {}): BrowserPostObservation {
  return {
    url: "https://www.threads.com/@own.profile/post/NEW123",
    author: identity.username,
    text: content,
    publishedAt: new Date(clock).toISOString(),
    ...overrides,
  };
}
function harness() {
  const events: string[] = [];
  const pauseCalls: number[] = [];
  const changes = {
    before: [] as BrowserPostObservation[],
    after: [post()],
    preparationError: undefined as Error | undefined,
    inspectionError: undefined as Error | undefined,
    sendingError: undefined as Error | undefined,
    afterReadError: undefined as Error | undefined,
    markError: undefined as Error | undefined,
    closeError: undefined as Error | undefined,
    liveIdentity: identity,
    identityAfterMark: undefined as BrowserIdentity | undefined,
    preparationDelayMs: 0,
    delayFirstConfirmation: false,
  };
  let now = clock;
  let sent = false;
  let confirmationReads = 0;
  const window: PublishingWindow = {
    verifyIdentity: async (expected) => {
      events.push("verify");
      assert.equal(expected.id, identity.id);
      assert.equal(expected.username, identity.username);
      if (changes.inspectionError) throw changes.inspectionError;
      return changes.liveIdentity;
    },
    readPosts: async (_username, navigate = true) => {
      events.push(navigate ? "profile" : "dom");
      if (!sent) events.push("before");
      else events.push("after");
      if (sent && changes.afterReadError) throw changes.afterReadError;
      if (sent && changes.delayFirstConfirmation && confirmationReads++ === 0) return [];
      return sent ? changes.after : changes.before;
    },
    prepare: async (text, username) => {
      events.push("prepare");
      assert.equal(text, content);
      assert.equal(username, identity.username);
      now += changes.preparationDelayMs;
      if (changes.preparationError) throw changes.preparationError;
    },
    send: async (text, username) => {
      assert.equal(text, content);
      assert.equal(username, identity.username);
      events.push("send");
      sent = true;
      if (changes.sendingError) throw changes.sendingError;
    },
    snapshot: async () => state,
    close: async () => {
      events.push("close");
      if (changes.closeError) throw changes.closeError;
    },
  };
  const provider = new BrowserThreadsProvider({
    open: async (_state, proxyOwner) => { assert.deepEqual(proxyOwner, { userId: "unit-test-user", username: identity.username }); events.push("open"); return window; },
    now: () => now,
    pause: async (milliseconds) => { pauseCalls.push(milliseconds); },
  });
  const input: BrowserPublishInput = {
    accountId: identity.id,
    username: identity.username,
    userId: "unit-test-user",
    socialAccountId: "unit-test-social-account",
    accessToken: savedSession,
    content,
    containerId: null,
    saveContainer: async () => { assert.fail("Browser publication has no Meta container"); },
    markPublishStarted: async () => {
      events.push("mark");
      if (changes.markError) throw changes.markError;
      if (changes.identityAfterMark) changes.liveIdentity = changes.identityAfterMark;
    },
    saveSession: async (sessionJSON) => { events.push("session"); assert.deepEqual(JSON.parse(sessionJSON), JSON.parse(savedSession)); },
  };
  return { provider, input, changes, events, pauseCalls };
}

test("publication checks account identity, prepares exact text and persists send boundary before clicking", async () => {
  const h = harness();
  assert.deepEqual(await h.provider.publishPost(h.input), {
    externalPostId: "https://www.threads.com/@own.profile/post/NEW123",
  });
  assert.deepEqual(h.events, ["open", "verify", "profile", "before", "prepare", "verify", "session", "mark", "verify", "send", "profile", "after", "verify", "close"]);
});

test("confirmation waits on the same profile DOM instead of reloading it repeatedly", async () => {
  const h = harness();
  h.changes.delayFirstConfirmation = true;
  assert.deepEqual(await h.provider.publishPost(h.input), {
    externalPostId: "https://www.threads.com/@own.profile/post/NEW123",
  });
  assert.equal(h.events.filter((event) => event === "profile").length, 2);
  assert.equal(h.events.filter((event) => event === "dom").length, 1);
  assert.equal(h.pauseCalls[0], 3000);
  assert.ok(h.pauseCalls.every((milliseconds) => milliseconds <= 3000));
});

test("an existing matching post is never accepted as evidence of a new publication", async () => {
  const h = harness();
  h.changes.before = [post()];
  await assert.rejects(h.provider.publishPost(h.input), { uncertain: true, retryable: false });
  assert.equal(h.events.filter((event) => event === "send").length, 1);
});

test("post evidence requires the intended author, exact text, new permalink and fresh timestamp", async () => {
  for (const observation of [
    post({ author: "another.profile" }),
    post({ text: content + " extra text" }),
    post({ url: "https://attacker.example/@own.profile/post/NEW123" }),
    post({ url: "https://www.threads.com/@other.profile/post/NEW123" }),
    post({ url: "https://www.threads.com/@own.profile" }),
    post({ url: "https://name:secret@www.threads.com/@own.profile/post/NEW123" }),
    post({ url: "https://www.threads.com:8443/@own.profile/post/NEW123" }),
    post({ publishedAt: null }),
    post({ publishedAt: "invalid-time" }),
    post({ publishedAt: new Date(clock - 60_000).toISOString() }),
    post({ publishedAt: new Date(clock + 60_000).toISOString() }),
  ]) {
    const h = harness();
    h.changes.after = [observation];
    await assert.rejects(h.provider.publishPost(h.input), { uncertain: true, retryable: false });
  }
});

test("two newly observed matching posts remain ambiguous instead of guessing success", async () => {
  const h = harness();
  h.changes.after.push(post({ url: "https://www.threads.com/@own.profile/post/OTHER123" }));
  await assert.rejects(h.provider.publishPost(h.input), { uncertain: true, retryable: false });
});

test("identical observations of one canonical permalink do not create false ambiguity", async () => {
  const h = harness();
  h.changes.after.push(post({ url: "https://www.threads.net/@own.profile/post/NEW123?source=share" }));
  assert.deepEqual(await h.provider.publishPost(h.input), { externalPostId: "https://www.threads.com/@own.profile/post/NEW123" });
});

test("failed composer preparation is safely retryable and never crosses the send boundary", async () => {
  const h = harness();
  h.changes.preparationError = new Error("A temporary browser failure");
  await assert.rejects(h.provider.publishPost(h.input), { retryable: true, uncertain: false });
  assert.equal(h.events.includes("mark"), false);
  assert.equal(h.events.includes("send"), false);
  assert.equal(h.events.at(-1), "close");
});

test("overlong preparation stops before persisting the send boundary or clicking Post", async () => {
  const h = harness();
  h.changes.preparationDelayMs = 120_000;
  await assert.rejects(h.provider.publishPost(h.input), { retryable: true, uncertain: false });
  assert.equal(h.events.includes("mark"), false);
  assert.equal(h.events.includes("send"), false);
  assert.equal(h.events.at(-1), "close");
});

test("a login challenge expires authorization before any text is submitted", async () => {
  const h = harness();
  h.changes.inspectionError = new ProviderError("Finish verification in Threads", { authExpired: true });
  await assert.rejects(h.provider.publishPost(h.input), { authExpired: true, uncertain: false, retryable: false });
  assert.deepEqual(h.events, ["open", "verify", "close"]);
});

test("a verified live account must match both saved numeric ID and username", async () => {
  for (const liveIdentity of [
    { ...identity, id: "999999" },
    { ...identity, username: "other.profile" },
  ]) {
    const h = harness();
    h.changes.liveIdentity = liveIdentity;
    await assert.rejects(h.provider.publishPost(h.input), { authExpired: true, uncertain: false });
    assert.deepEqual(h.events, ["open", "verify", "close"]);
  }
});

test("failed persistence of the send boundary never clicks Post", async () => {
  const h = harness();
  h.changes.markError = new Error("Database temporarily unavailable");
  await assert.rejects(h.provider.publishPost(h.input), { retryable: true, uncertain: false });
  assert.equal(h.events.includes("mark"), true);
  assert.equal(h.events.includes("send"), false);
});

test("an account switch while persisting the send boundary stops before the UI click", async () => {
  const h = harness();
  h.changes.identityAfterMark = { ...identity, id: "999999", username: "another.profile" };
  await assert.rejects(h.provider.publishPost(h.input), { uncertain: true, retryable: false });
  assert.equal(h.events.includes("mark"), true);
  assert.equal(h.events.includes("send"), false);
});

test("any click failure is uncertain because Threads may already have received it", async () => {
  const h = harness();
  h.changes.sendingError = new Error("The browser disconnected after dispatch");
  await assert.rejects(h.provider.publishPost(h.input), { uncertain: true, retryable: false });
  assert.equal(h.events.filter((event) => event === "send").length, 1);
});

test("a post-submit verification failure cannot retry or report a successful post", async () => {
  const h = harness();
  h.changes.afterReadError = new ProviderError("Login expired during confirmation", { authExpired: true, retryable: true });
  await assert.rejects(h.provider.publishPost(h.input), { uncertain: true, retryable: false, authExpired: false });
});

test("closing the browser cannot erase a previously confirmed publication", async () => {
  const h = harness();
  h.changes.closeError = new Error("Browser process already exited");
  assert.deepEqual(await h.provider.publishPost(h.input), { externalPostId: "https://www.threads.com/@own.profile/post/NEW123" });
});

test("invalid session payload, mismatched account and empty or long content fail before opening a browser", async () => {
  for (const invalid of [
    { accessToken: "invalid-json" },
    { accessToken: JSON.stringify({ version: 1, storageState: { cookies: [], origins: [] } }) },
    { accountId: "999999" },
    { username: "../another-account" },
    { content: " " },
    { content: "x".repeat(501) },
  ]) {
    const h = harness();
    await assert.rejects(h.provider.publishPost({ ...h.input, ...invalid }), ProviderError);
    assert.deepEqual(h.events, []);
  }
});

test("concurrent publications for one Threads identity serialize and respect the minimum send interval", async () => {
  let now = clock;
  let nextWindow = 0;
  const events: string[] = [];
  const submittedAt: number[] = [];
  const provider = new BrowserThreadsProvider({
    now: () => now,
    pause: async (milliseconds) => { events.push("pause:" + milliseconds); now += milliseconds; },
    open: async () => {
      const index = ++nextWindow;
      events.push("open:" + index);
      let sent = false;
      return {
        verifyIdentity: async () => identity,
        readPosts: async () => sent ? [post({
          url: "https://www.threads.com/@own.profile/post/NEW" + index,
          publishedAt: new Date(now).toISOString(),
        })] : [],
        prepare: async () => undefined,
        send: async () => { sent = true; submittedAt.push(now); events.push("send:" + index); },
        snapshot: async () => state,
        close: async () => { events.push("close:" + index); },
      };
    },
  });
  const input = harness().input;
  const first = provider.publishPost(input);
  const second = provider.publishPost(input);
  assert.deepEqual(await Promise.all([first, second]), [
    { externalPostId: "https://www.threads.com/@own.profile/post/NEW1" },
    { externalPostId: "https://www.threads.com/@own.profile/post/NEW2" },
  ]);
  assert.deepEqual(events, [
    "open:1", "send:1", "pause:3000", "close:1",
    "pause:5000", "open:2", "send:2", "pause:3000", "close:2",
  ]);
  assert.deepEqual(submittedAt, [clock, clock + 8000]);
});

test("a queued publication reloads the session saved by the previous publication before opening its browser", async () => {
  let now = clock;
  let latest = savedSession;
  let nextWindow = 0;
  const restored: BrowserStorageState[] = [];
  const refreshedState = {
    ...state,
    cookies: state.cookies.map((cookie) => cookie.name === "sessionid" ? { ...cookie, value: "refreshed-unit-session" } : cookie),
  };
  const refreshedSession = JSON.stringify({ version: 1, storageState: refreshedState });
  const provider = new BrowserThreadsProvider({
    now: () => now,
    pause: async (milliseconds) => { now += milliseconds; },
    open: async (restoredState) => {
      restored.push(restoredState);
      const index = ++nextWindow;
      let sent = false;
      return {
        verifyIdentity: async () => identity,
        readPosts: async () => sent ? [post({ url: "https://www.threads.com/@own.profile/post/NEW" + index, publishedAt: new Date(now).toISOString() })] : [],
        prepare: async () => undefined,
        send: async () => { sent = true; },
        snapshot: async () => refreshedState,
        close: async () => undefined,
      };
    },
  });
  const input = {
    ...harness().input,
    loadSession: async () => latest,
    saveSession: async (sessionJSON: string) => { latest = sessionJSON; },
  };
  await Promise.all([provider.publishPost(input), provider.publishPost(input)]);
  assert.equal(latest, refreshedSession);
  assert.deepEqual(restored, [state, refreshedState]);
});

test("profile extraction survives serialization without Node or tsx helper bindings", () => {
  const observations = runInNewContext("(" + collectProfilePosts.toString() + ")()", {
    document: { querySelectorAll: () => [] },
  });
  assert.equal(Array.isArray(observations), true);
  assert.equal(observations.length, 0);
});

test("profile extraction reads the current Threads card without a legacy wrapper or dir attribute", async () => {
  const browser = await createThreadsBrowser({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <base href="https://www.threads.com/">
      <main>
        <article data-pressable-container="true">
          <a href="/@own.profile"><img alt="own.profile avatar" width="36" height="36"></a>
          <a href="/@own.profile"><span>own.profile</span></a>
          <a href="/@own.profile/post/NEW"><time datetime="2026-10-05T10:00:01.000Z"><span>now</span></time></a>
          <div><span>Published text with <a href="https://example.com/tag">a link</a></span></div>
          <button>Like</button>
        </article>
      </main>
    `);
    assert.deepEqual(await page.evaluate(collectProfilePosts), [{
      url: "https://www.threads.com/@own.profile/post/NEW",
      author: "own.profile",
      text: "Published text with a link",
      publishedAt: "2026-10-05T10:00:01.000Z",
    }]);
  } finally {
    await browser.close();
  }
});

test("profile extraction keeps nested inline text and line breaks while excluding a quoted post", async () => {
  const browser = await createThreadsBrowser({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <article data-pressable-container="true">
          <header><a href="/@own.profile">own.profile</a></header>
          <a href="/@own.profile/post/INLINE"><time datetime="2026-10-05T10:00:01.000Z">now</time></a>
          <div class="body">Keep <strong>nested <em>inline</em></strong><br><span>line <a href="https://example.com/tag">with a link</a> and <a href="/@mentioned">@mentioned</a></span></div>
          <article data-pressable-container="true">
            <a href="/@quoted.profile">quoted.profile</a>
            <a href="/@quoted.profile/post/QUOTED"><time datetime="2026-10-05T09:00:00.000Z">1h</time></a>
            <div>Quoted text must not leak into the owner post.</div>
          </article>
          <div role="button">Like Reply</div>
        </article>
      </main>
    `);
    assert.deepEqual(await page.evaluate(collectProfilePosts), [
      {
        url: "https://www.threads.com/@own.profile/post/INLINE",
        author: "own.profile",
        text: "Keep nested inline\nline with a link and @mentioned",
        publishedAt: "2026-10-05T10:00:01.000Z",
      },
      {
        url: "https://www.threads.com/@quoted.profile/post/QUOTED",
        author: "quoted.profile",
        text: "Quoted text must not leak into the owner post.",
        publishedAt: "2026-10-05T09:00:00.000Z",
      },
    ]);
  } finally {
    await browser.close();
  }
});

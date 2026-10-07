import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptToken,
  encryptToken,
  hashPassword,
  hashToken,
  randomToken,
  verifyPassword,
} from "./security.js";
import { postInputSchema, postQuerySchema, registerSchema } from "./validation.js";
import { aggregateStatus } from "./scheduler.js";
import { config } from "./config.js";
import {
  MetaThreadsProvider,
  ProviderError,
  type PublishInput,
} from "./providers.js";

test("passwords are salted, verified and never stored as plaintext", async () => {
  const hash = await hashPassword("LongPasswordForTest!");
  assert.notEqual(hash, "LongPasswordForTest!");
  assert.equal(await verifyPassword("LongPasswordForTest!", hash), true);
  assert.equal(await verifyPassword("wrong-password", hash), false);
});

test("encrypted account tokens roundtrip with unique nonces and reject tampering", () => {
  const first = encryptToken("private-account-token");
  const second = encryptToken("private-account-token");
  assert.notEqual(first, second);
  assert.ok(!first.includes("private-account-token"));
  assert.equal(decryptToken(first), "private-account-token");
  const parts = first.split(".");
  const ciphertext = Buffer.from(parts[2]!, "base64");
  ciphertext[0] = ciphertext[0]! ^ 1;
  parts[2] = ciphertext.toString("base64");
  assert.throws(() => decryptToken(parts.join(".")));
});

test("opaque sessions are random and only their one-way hashes identify stored sessions", () => {
  const first = randomToken();
  const second = randomToken();
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, second);
  assert.notEqual(hashToken(first), first);
  assert.equal(hashToken(first), hashToken(first));
});

test("post validation counts Unicode characters and rejects duplicate targets and past times", () => {
  const draft = {
    content: "🙂".repeat(500),
    accountIds: ["account-1"],
    status: "draft",
    timezone: "Asia/Shanghai",
  };
  assert.ok(postInputSchema.safeParse(draft).success);
  assert.ok(
    !postInputSchema.safeParse({ ...draft, content: "🙂".repeat(501) }).success,
  );
  assert.ok(
    !postInputSchema.safeParse({ ...draft, accountIds: ["a", "a"] }).success,
  );
  assert.ok(
    !postInputSchema.safeParse({ ...draft, timezone: "Invalid/Zone" }).success,
  );
  assert.ok(
    !postInputSchema.safeParse({
      ...draft,
      status: "scheduled",
      scheduledAt: "2020-01-01T00:00:00Z",
    }).success,
  );
});

test("registration normalizes email and prevents bcrypt byte truncation", () => {
  const user = registerSchema.parse({
    email: " User@Example.com ",
    name: " User ",
    password: "ValidPassword123!",
    timezone: "UTC",
  });
  assert.equal(user.email, "user@example.com");
  assert.equal(user.name, "User");
  assert.ok(
    !registerSchema.safeParse({ ...user, password: "🙂".repeat(20) }).success,
  );
});

test("multi-account aggregate preserves in-progress work and reflects partial failures", () => {
  assert.equal(aggregateStatus(["published", "publishing"]), "publishing");
  assert.equal(aggregateStatus(["published", "scheduled"]), "scheduled");
  assert.equal(aggregateStatus(["published", "failed"]), "failed");
  assert.equal(aggregateStatus(["published", "unconfirmed"]), "unconfirmed");
  assert.equal(aggregateStatus(["scheduled", "unconfirmed"]), "scheduled");
  assert.equal(aggregateStatus(["published", "published"]), "published");
  assert.equal(aggregateStatus(["cancelled", "cancelled"]), "cancelled");
});

test("post search accepts the confirmation-needed status", () => {
  assert.equal(postQuerySchema.parse({ status: "unconfirmed" }).status, "unconfirmed");
});

function publication(overrides: Partial<PublishInput> = {}): PublishInput {
  return {
    accountId: "provider-account",
    accessToken: "fake-token",
    content: "A test conversation",
    containerId: null,
    saveContainer: async () => {},
    markPublishStarted: async () => {},
    ...overrides,
  };
}

test("real token import validates Meta permissions, expiry and profile identity", async () => {
  const original = globalThis.fetch;
  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 86400;
  const requested: string[] = [];
  globalThis.fetch = async (url, options) => {
    const target = new URL(String(url));
    assert.equal(target.origin, "https://graph.threads.com");
    assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer private-test-user-token");
    requested.push(target.pathname);
    if (target.pathname.endsWith("/debug_token")) {
      assert.equal(target.searchParams.get("input_token"), "private-test-user-token");
      return Response.json({ data: { is_valid: true, app_id: config.META_APP_ID || "test-threads-app", user_id: "profile-1", scopes: ["threads_basic", "threads_content_publish"], expires_at: expiresAt } });
    }
    return Response.json({ id: "profile-1", username: "my_threads", name: "My Threads", threads_profile_picture_url: "https://example.com/avatar.jpg" });
  };
  try {
    const result = await new MetaThreadsProvider().connectWithToken("private-test-user-token");
    assert.equal(result.account.id, "profile-1");
    assert.equal(result.account.username, "my_threads");
    assert.equal(result.accessToken, "private-test-user-token");
    assert.equal(result.expiresAt.getTime(), expiresAt * 1000);
    assert.deepEqual(requested, ["/v1.0/debug_token", "/v1.0/me"]);
  } finally { globalThis.fetch = original; }
});

test("token import refuses missing publish scope, expired tokens and another configured app", async () => {
  const original = globalThis.fetch;
  const appId = config.META_APP_ID;
  config.META_APP_ID = "expected-app";
  let payload = { is_valid: true, app_id: "expected-app", scopes: ["threads_basic"], expires_at: Math.floor(Date.now() / 1000) + 6000 };
  globalThis.fetch = async () => Response.json({ data: payload });
  try {
    await assert.rejects(new MetaThreadsProvider().connectWithToken("test-token"), /threads_content_publish/);
    payload = { ...payload, scopes: ["threads_basic", "threads_content_publish"], expires_at: 1 };
    await assert.rejects(new MetaThreadsProvider().connectWithToken("test-token"), /expired/);
    payload = { ...payload, expires_at: Math.floor(Date.now() / 1000) + 6000, app_id: "another-app" };
    await assert.rejects(new MetaThreadsProvider().connectWithToken("test-token"), /different Meta app/);
  } finally { globalThis.fetch = original; config.META_APP_ID = appId; }
});

test("OAuth uses current Meta hosts, minimal scopes and exact registered redirect in token exchange", async () => {
  const original = globalThis.fetch;
  const previous = { META_APP_ID: config.META_APP_ID, META_APP_SECRET: config.META_APP_SECRET, META_REDIRECT_URI: config.META_REDIRECT_URI };
  Object.assign(config, { META_APP_ID: "threads-app-id", META_APP_SECRET: "private-test-app-secret", META_REDIRECT_URI: "https://project.supabase.co/functions/v1/threads-oauth" });
  const calls: string[] = [];
  globalThis.fetch = async (url, options) => {
    const target = new URL(String(url));
    assert.equal(target.origin, "https://graph.threads.com");
    calls.push(target.pathname);
    if (target.pathname === "/oauth/access_token") {
      const params = new URLSearchParams(String(options?.body));
      assert.equal(options?.method, "POST");
      assert.equal(params.get("redirect_uri"), config.META_REDIRECT_URI);
      assert.equal(params.get("code"), "authorization-code");
      assert.equal(params.get("client_secret"), "private-test-app-secret");
      return Response.json({ access_token: "short-test-token", user_id: "profile-1" });
    }
    if (target.pathname === "/access_token") {
      assert.equal(target.searchParams.get("grant_type"), "th_exchange_token");
      assert.equal(target.searchParams.get("access_token"), "short-test-token");
      return Response.json({ access_token: "long-test-token", expires_in: 5184000 });
    }
    return Response.json({ id: "profile-1", username: "real_profile" });
  };
  try {
    const provider = new MetaThreadsProvider();
    const authorization = new URL(provider.authorizationUrl("opaque-state"));
    assert.equal(authorization.origin, "https://www.threads.com");
    assert.equal(authorization.searchParams.get("scope"), "threads_basic,threads_content_publish");
    assert.equal(authorization.searchParams.get("state"), "opaque-state");
    assert.equal(authorization.searchParams.get("redirect_uri"), config.META_REDIRECT_URI);
    const connected = await provider.connectAccount("authorization-code");
    assert.equal(connected.account.id, "profile-1");
    assert.equal(connected.accessToken, "long-test-token");
    assert.deepEqual(calls, ["/oauth/access_token", "/access_token", "/v1.0/me"]);
  } finally { globalThis.fetch = original; Object.assign(config, previous); }
});

test("real long-lived token refresh uses th_refresh_token and validates expiry", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = new URL(String(url));
    assert.equal(target.pathname, "/refresh_access_token");
    assert.equal(target.searchParams.get("grant_type"), "th_refresh_token");
    assert.equal(target.searchParams.get("access_token"), "private-test-user-token");
    return Response.json({ access_token: "renewed-test-token", expires_in: 5184000 });
  };
  try {
    const refreshed = await new MetaThreadsProvider().refreshToken("private-test-user-token");
    assert.equal(refreshed.accessToken, "renewed-test-token");
    assert.ok(refreshed.expiresAt.getTime() > Date.now() + 59 * 86400000);
  } finally { globalThis.fetch = original; }
});

test("Meta errors identify expired access and missing permission without exposing response secrets", async () => {
  const original = globalThis.fetch;
  let code = 190;
  globalThis.fetch = async () => Response.json({ error: { code, message: "private-test-user-token remote payload" } }, { status: 400 });
  try {
    await assert.rejects(new MetaThreadsProvider().getAccountInfo("private-test-user-token"), (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.authExpired, true);
      assert.ok(!error.message.includes("private-test-user-token"));
      return true;
    });
    code = 10;
    await assert.rejects(new MetaThreadsProvider().getAccountInfo("private-test-user-token"), /threads_content_publish/);
    code = 4;
    await assert.rejects(new MetaThreadsProvider().getAccountInfo("private-test-user-token"), (error) => error instanceof ProviderError && error.retryable);
  } finally { globalThis.fetch = original; }
});

test("Meta persists container and irreversible boundary before sending publish request", async () => {
  const original = globalThis.fetch;
  const events: string[] = [];
  globalThis.fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/threads")) return Response.json({ id: "container-1" });
    if (path.endsWith("/container-1"))
      return Response.json({ status: "FINISHED" });
    assert.ok(path.endsWith("/threads_publish"));
    assert.deepEqual(events, ["save:container-1", "boundary"]);
    assert.equal(options?.method, "POST");
    assert.equal(String(options?.body), "creation_id=container-1");
    events.push("publish");
    return Response.json({ id: "external-1" });
  };
  try {
    const result = await new MetaThreadsProvider().publishPost(
      publication({
        saveContainer: async (id) => {
          events.push(`save:${id}`);
        },
        markPublishStarted: async () => {
          events.push("boundary");
        },
      }),
    );
    assert.equal(result.externalPostId, "external-1");
    assert.deepEqual(events, ["save:container-1", "boundary", "publish"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("Meta uncertainty blocks automatic retries and does not expose raw credentials", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/threads_publish"))
      throw new TypeError("fake-token leaked remote failure");
    return Response.json({ status: "FINISHED" });
  };
  try {
    await assert.rejects(
      new MetaThreadsProvider().publishPost(
        publication({ containerId: "existing-container" }),
      ),
      (error) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.uncertain, true);
        assert.equal(error.retryable, false);
        assert.ok(!error.message.includes("fake-token"));
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("Meta container propagation refusal safely retries the saved container", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/threads_publish"))
      return Response.json({ error: { code: 100, error_subcode: 4279009, message: "Media not yet available" } }, { status: 400 });
    return Response.json({ status: "FINISHED" });
  };
  try {
    await assert.rejects(new MetaThreadsProvider().publishPost(publication({ containerId: "saved-container" })), (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.retryable, true);
      assert.equal(error.uncertain, false);
      return true;
    });
  } finally { globalThis.fetch = original; }
});

test("a previously published Meta container cannot be sent a second time", async () => {
  const original = globalThis.fetch;
  let requested = 0;
  globalThis.fetch = async () => {
    requested++;
    return Response.json({ status: "PUBLISHED" });
  };
  try {
    await assert.rejects(
      new MetaThreadsProvider().publishPost(
        publication({ containerId: "already-sent" }),
      ),
      (error) => error instanceof ProviderError && error.uncertain,
    );
    assert.equal(requested, 1);
  } finally {
    globalThis.fetch = original;
  }
});

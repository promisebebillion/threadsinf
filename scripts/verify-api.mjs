import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

// Exercise the live API and Supabase without opening a browser or publishing.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
dotenv.config({ path: join(root, "apps/api/.env"), quiet: true });
const baseUrl = process.env.VERIFY_API_URL ?? "http://localhost:3000";
const origin = process.env.VERIFY_FRONTEND_URL ?? "http://localhost:5173";
const runId = `${Date.now()}-${randomBytes(6).toString("hex")}`;
const emails = [
  `verify-${runId}@example.test`,
  `verify-other-${runId}@example.test`,
];
const password = `Verify!${randomBytes(20).toString("hex")}`;
const alice = { cookie: "" };
const bob = { cookie: "" };
const anonymous = { cookie: "" };
const database = new PrismaClient();
const report = {
  runId,
  baseUrl,
  origin,
  startedAt: new Date().toISOString(),
  checks: [],
  resources: {},
  limitations: [
    "A genuine Threads login, encrypted session capture and restoration require manual account login and were not verified by this run.",
    "No external post was published. Scheduled publication against Threads was not verified by this run.",
  ],
};
let currentCheck = "Supabase configuration";
let cleanupRequired = false;

function noSecrets(value, path = "response") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    // Zod fieldErrors uses input field names as labels, with message arrays.
    if (path === "response.details.fieldErrors" && Array.isArray(child)) continue;
    assert.doesNotMatch(
      key,
      /^(accessToken|refreshToken|passwordHash|encryptedToken|tokenCiphertext|accessTokenEncrypted|refreshTokenEncrypted|storageState|browserStorageState|sessionState|encryptedSession|cookies|localStorage)$/i,
      "A secret field escaped through the API",
    );
    noSecrets(child, `${path}.${key}`);
  }
}

async function request(session, method, path, body, options = {}) {
  const headers = {
    origin,
    "x-threadflow-client": "web",
    ...(session.cookie ? { cookie: session.cookie } : {}),
    ...options.headers,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (options.omitOrigin) delete headers.origin;
  if (options.omitClient) delete headers["x-threadflow-client"];
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  for (const cookie of response.headers.getSetCookie?.() ?? []) {
    session.cookie = cookie.split(";", 1)[0];
  }
  const content = await response.text();
  const data = content && response.status < 300 ? JSON.parse(content) : null;
  let errorData = data;
  if (content && response.status >= 400) {
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    errorData = JSON.parse(content);
  }
  noSecrets(errorData);
  return { status: response.status, data: errorData, headers: response.headers };
}

function expectStatus(result, status) {
  assert.equal(result.status, status, `Unexpected HTTP status: ${result.status}`);
  return result.data;
}

function expectError(result, status = 400) {
  expectStatus(result, status);
  assert.equal(typeof result.data?.error, "string");
}

async function check(name, fn) {
  currentCheck = name;
  const started = Date.now();
  await fn();
  report.checks.push({ name, status: "passed", durationMs: Date.now() - started });
  console.log(`PASS ${name}`);
}

const timeIn = (seconds) => new Date(Date.now() + seconds * 1000).toISOString();
const calendarPath = `/api/calendar?start=${encodeURIComponent(timeIn(-3600))}&end=${encodeURIComponent(timeIn(3600))}`;
const postInput = (content, accountIds = [], status = "draft", scheduledAt) => ({
  content,
  accountIds,
  status,
  timezone: "Asia/Shanghai",
  ...(scheduledAt ? { scheduledAt } : {}),
});

try {
  const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
  assert.ok(["postgres:", "postgresql:"].includes(databaseUrl.protocol));
  assert.ok(
    databaseUrl.hostname.endsWith(".supabase.co") ||
      databaseUrl.hostname.endsWith(".pooler.supabase.com"),
    "Verification requires the Supabase database configured for the API",
  );
  await check("Live API connects to Supabase and uses browser sessions", async () => {
    const health = expectStatus(await request(anonymous, "GET", "/api/health"), 200);
    assert.equal(health.status, "ok");
    assert.equal(health.database, "supabase");
    assert.equal(health.provider, "browser");
    assert.equal(typeof health.sessionLoginConfigured, "boolean");
    report.sessionLoginConfigured = health.sessionLoginConfigured;
  });
  await check("Supabase application tables deny public database access", async () => {
    const tables = await database.$queryRaw`
      SELECT c.relname AS name, c.relrowsecurity AS rls,
        has_table_privilege('anon', c.oid, 'SELECT') AS anon_select,
        has_table_privilege('authenticated', c.oid, 'SELECT') AS authenticated_select
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname IN ('User','Session','OAuthState','SocialAccount','Post','PostTarget','AccountProxy')
    `;
    assert.equal(tables.length, 7);
    assert.ok(tables.every((table) => table.rls && !table.anon_select && !table.authenticated_select));
  });
  await check("CORS permits both local frontend addresses", async () => {
    const origins = new Set([origin]);
    const frontend = new URL(origin);
    if (["localhost", "127.0.0.1"].includes(frontend.hostname)) {
      frontend.hostname = frontend.hostname === "localhost" ? "127.0.0.1" : "localhost";
      origins.add(frontend.origin);
    }
    for (const allowedOrigin of origins) {
      const result = await request(anonymous, "OPTIONS", "/api/auth/me", undefined, {
        headers: {
          origin: allowedOrigin,
          "access-control-request-method": "GET",
          "access-control-request-headers": "x-threadflow-client",
        },
      });
      expectStatus(result, 204);
      assert.equal(result.headers.get("access-control-allow-origin"), allowedOrigin);
      assert.equal(result.headers.get("access-control-allow-credentials"), "true");
    }
  });
  await check("Protected endpoints reject anonymous sessions", async () => {
    for (const path of ["/api/auth/me", "/api/provider", "/api/accounts", "/api/accounts/connections/missing", "/api/posts", "/api/dashboard", calendarPath]) {
      expectError(await request(anonymous, "GET", path), 401);
    }
    for (const path of ["/api/accounts/connect", "/api/accounts/connections/missing/save", "/api/accounts/connections/missing/cancel", "/api/accounts/missing/open", "/api/accounts/missing/verify"]) {
      expectError(await request(anonymous, "POST", path, {}), 401);
    }
  });
  await check("Registration rejects invalid identity and timezone", async () => {
    expectError(await request(anonymous, "POST", "/api/auth/register", {
      email: "invalid", password: "short", name: "", timezone: "Invalid/Zone",
    }));
  });
  await check("Two temporary users receive independent HttpOnly sessions", async () => {
    cleanupRequired = true;
    for (const [index, session] of [alice, bob].entries()) {
      const result = await request(session, "POST", "/api/auth/register", {
        email: emails[index], password, name: `Verification ${index + 1}`, timezone: "UTC",
      });
      const { user } = expectStatus(result, 201);
      assert.equal(user.email, emails[index]);
      assert.match(result.headers.get("set-cookie") ?? "", /HttpOnly/i);
      assert.match(session.cookie, /^threadflow_session=[a-f0-9]{64}$/);
      report.resources[index === 0 ? "primaryUserId" : "secondaryUserId"] = user.id;
      const saved = await database.user.findUnique({ where: { email: emails[index] }, select: { id: true } });
      assert.equal(saved?.id, user.id, "API and verifier must connect to the same Supabase database");
    }
    assert.notEqual(alice.cookie, bob.cookie);
  });
  await check("Profile changes remain isolated between users", async () => {
    const { user } = expectStatus(await request(alice, "PATCH", "/api/auth/me", {
      name: "Updated verification user", timezone: "Asia/Shanghai",
    }), 200);
    assert.equal(user.id, report.resources.primaryUserId);
    assert.equal(user.timezone, "Asia/Shanghai");
    const other = expectStatus(await request(bob, "GET", "/api/auth/me"), 200).user;
    assert.equal(other.id, report.resources.secondaryUserId);
    assert.equal(other.name, "Verification 2");
    assert.equal(other.timezone, "UTC");
  });
  await check("Logout revokes the old session and correct login restores access", async () => {
    const oldSession = { cookie: alice.cookie };
    expectStatus(await request(alice, "POST", "/api/auth/logout"), 204);
    expectError(await request(oldSession, "GET", "/api/auth/me"), 401);
    expectError(await request(alice, "POST", "/api/auth/login", { email: emails[0], password: "incorrect-password" }), 401);
    const { user } = expectStatus(await request(alice, "POST", "/api/auth/login", { email: emails[0], password }), 200);
    assert.equal(user.id, report.resources.primaryUserId);
    assert.notEqual(alice.cookie, oldSession.cookie);
  });
  await check("Mutation requests require the application origin and header", async () => {
    for (const options of [
      { headers: { origin: "https://attacker.example" } },
      { omitClient: true },
      { omitOrigin: true },
    ]) {
      expectError(await request(alice, "PATCH", "/api/auth/me", { name: "Rejected change", timezone: "UTC" }, options), 403);
    }
  });
  await check("New workspaces contain no fabricated accounts or posts", async () => {
    for (const session of [alice, bob]) {
      assert.deepEqual(expectStatus(await request(session, "GET", "/api/accounts"), 200), []);
      assert.deepEqual(expectStatus(await request(session, "GET", "/api/posts"), 200), []);
      assert.deepEqual(expectStatus(await request(session, "GET", calendarPath), 200), []);
      const dashboard = expectStatus(await request(session, "GET", "/api/dashboard"), 200);
      for (const key of ["connectedAccounts", "scheduledPosts", "publishedPosts", "failedPosts"]) assert.equal(dashboard[key], 0);
      assert.deepEqual(dashboard.upcomingPosts, []);
      assert.deepEqual(dashboard.recentPosts, []);
    }
  });
  await check("Mock account endpoints and legacy connection bodies are removed", async () => {
    expectError(await request(alice, "GET", "/api/accounts/mock"), 404);
    expectError(await request(alice, "POST", "/api/accounts/connect", { mockAccountId: "removed" }));
  });
  await check("Threads configuration reports actual browser login readiness", async () => {
    const provider = expectStatus(await request(alice, "GET", "/api/provider"), 200);
    assert.deepEqual(expectStatus(await request(alice, "GET", "/api/accounts/provider"), 200), provider);
    assert.equal(provider.provider, "browser");
    assert.equal(provider.configured, report.sessionLoginConfigured);
    assert.ok(Array.isArray(provider.missing));
    assert.equal(provider.missing.length === 0, provider.configured);
    assert.equal(provider.loginUrl, "https://www.threads.com/login");
    // Starting a valid connection would open a visible browser. This verifier
    // checks readiness without starting or interrupting a manual login.
    report.browserLogin = { configured: provider.configured, loginUrl: provider.loginUrl };
  });
  await check("Unknown session connections cannot be read, saved or cancelled", async () => {
    for (const session of [alice, bob]) {
      expectError(await request(session, "GET", "/api/accounts/connections/missing"), 404);
      for (const action of ["save", "cancel"]) {
        expectError(await request(session, "POST", `/api/accounts/connections/missing/${action}`, action === "save" ? { username: "verification.profile" } : {}), 404);
      }
    }
  });
  await check("Invalid OAuth state cannot create an account", async () => {
    expectError(await request(alice, "GET", "/api/accounts/oauth/callback?state=bad&code=unused"));
    expectError(await request(alice, "GET", `/api/accounts/oauth/callback?state=${"0".repeat(64)}&error=access_denied`));
  });
  await check("Token import validates input before contacting Meta", async () => {
    for (const input of [{}, { accessToken: "short" }, { accessToken: 123 }, { accessToken: "short", extra: true }]) {
      expectError(await request(alice, "POST", "/api/accounts/connect-token", input));
    }
    assert.deepEqual(expectStatus(await request(alice, "GET", "/api/accounts"), 200), []);
  });
  await check("Unknown accounts cannot be reopened, reconnected or disconnected", async () => {
    expectError(await request(alice, "POST", "/api/accounts/missing/open", {}), 404);
    expectError(await request(alice, "POST", "/api/accounts/missing/verify", {}), 404);
    expectError(await request(alice, "POST", "/api/accounts/missing/reconnect", {}), 404);
    expectError(await request(alice, "DELETE", "/api/accounts/missing"), 404);
  });
  let draft;
  await check("Post validation prevents publication without connected real accounts", async () => {
    const noAccountDraft = await request(alice, "POST", "/api/posts", postInput(`Verification draft ${runId}`));
    if (noAccountDraft.status === 201) {
      draft = noAccountDraft.data;
      assert.equal(draft.status, "draft");
      assert.deepEqual(draft.targets, []);
    } else {
      expectError(noAccountDraft);
    }
    for (const input of [
      postInput("No account schedule", [], "scheduled", timeIn(3600)),
      postInput("Unknown account", ["missing-account"]),
      postInput(" ", ["missing-account"]),
      postInput("x".repeat(501), ["missing-account"]),
      postInput("Duplicate account", ["missing-account", "missing-account"]),
      postInput("Invalid status", ["missing-account"], "published"),
      postInput("Past date", ["missing-account"], "scheduled", timeIn(-3600)),
      postInput("Invalid date", ["missing-account"], "scheduled", "not-a-date"),
      { ...postInput("Invalid timezone", ["missing-account"]), timezone: "Invalid/Zone" },
    ]) expectError(await request(alice, "POST", "/api/posts", input));
  });
  await check("A temporary Supabase draft can be retrieved only by its owner", async () => {
    // The current composer requires an account even for drafts. A targetless DB
    // fixture exercises ownership of preserved drafts without fabricating an account.
    if (!draft) {
      draft = await database.post.create({ data: {
        userId: report.resources.primaryUserId,
        content: `Verification draft ${runId}`,
        status: "draft",
        timezone: "Asia/Shanghai",
      } });
    }
    report.resources.temporaryPostId = draft.id;
    const read = expectStatus(await request(alice, "GET", `/api/posts/${draft.id}`), 200);
    assert.equal(read.content, draft.content);
    assert.equal(read.status, "draft");
    assert.deepEqual(read.targets, []);
    expectError(await request(alice, "POST", `/api/posts/${draft.id}/publish-now`, undefined));
    const unchanged = await database.post.findUnique({ where: { id: draft.id } });
    assert.equal(unchanged?.status, "draft", "A targetless draft must remain a draft after a rejected publication");
    for (const [method, suffix, body] of [
      ["GET", "", undefined],
      ["PATCH", "", postInput("Unauthorized edit", ["missing-account"])],
      ["DELETE", "", undefined],
      ["POST", "/publish-now", undefined],
      ["POST", "/reschedule", { scheduledAt: timeIn(3600), timezone: "UTC" }],
    ]) expectError(await request(bob, method, `/api/posts/${draft.id}${suffix}`, body), 404);
  });
  await check("Post lists, search and calendar honor workspace ownership", async () => {
    for (const path of ["/api/posts", "/api/posts?status=draft", `/api/posts?search=${encodeURIComponent(runId)}`]) {
      const posts = expectStatus(await request(alice, "GET", path), 200);
      assert.deepEqual(posts.map((post) => post.id), [draft.id]);
      assert.deepEqual(expectStatus(await request(bob, "GET", path), 200), []);
    }
    assert.deepEqual(expectStatus(await request(alice, "GET", calendarPath), 200), []);
    expectError(await request(alice, "GET", "/api/calendar?start=bad&end=bad"));
    expectError(await request(alice, "GET", "/api/posts?status=invalid"));
    expectError(await request(alice, "GET", "/api/posts/missing"), 404);
  });
  await check("Cancelling a preserved draft persists without any external publication", async () => {
    expectStatus(await request(alice, "DELETE", `/api/posts/${draft.id}`), 204);
    const saved = await database.post.findUnique({ where: { id: draft.id } });
    assert.equal(saved?.status, "cancelled");
    assert.equal(await database.postTarget.count({ where: { postId: draft.id } }), 0);
    assert.equal(await database.socialAccount.count({ where: { userId: { in: [report.resources.primaryUserId, report.resources.secondaryUserId] } } }), 0);
  });
  await check("Final logout removes both verification sessions", async () => {
    for (const session of [alice, bob]) {
      expectStatus(await request(session, "POST", "/api/auth/logout"), 204);
      expectError(await request(session, "GET", "/api/auth/me"), 401);
    }
  });
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failedCheck = currentCheck;
  report.error = error instanceof Error ? error.message : "Unknown verification error";
  // Keep passwords and connection credentials out of logs and the saved report.
  for (const secret of [password, process.env.DATABASE_URL]) {
    if (secret) report.error = report.error.replaceAll(secret, "[redacted]");
  }
  console.error(`FAIL ${currentCheck}: ${report.error}`);
  process.exitCode = 1;
} finally {
  try {
    const cleanup = cleanupRequired ? await database.$transaction(async (transaction) => {
      // Exact emails from this run also catch a registration whose response failed.
      const users = await transaction.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
      const userIds = users.map((user) => user.id);
      const targets = await transaction.postTarget.deleteMany({ where: { post: { userId: { in: userIds } } } });
      const posts = await transaction.post.deleteMany({ where: { userId: { in: userIds } } });
      const accounts = await transaction.socialAccount.deleteMany({ where: { userId: { in: userIds } } });
      const deletedUsers = await transaction.user.deleteMany({ where: { id: { in: userIds }, email: { in: emails } } });
      return { users: deletedUsers.count, posts: posts.count, accounts: accounts.count, targets: targets.count };
    }, { timeout: 20_000 }) : { users: 0, posts: 0, accounts: 0, targets: 0 };
    if (cleanupRequired) {
      assert.equal(await database.user.count({ where: { email: { in: emails } } }), 0);
    }
    report.cleanup = { status: "passed", deleted: cleanup };
    console.log("PASS Temporary verification data removed from Supabase");
  } catch (error) {
    report.cleanup = { status: "failed", error: error instanceof Error ? error.name : "UnknownError" };
    report.status = "failed";
    process.exitCode = 1;
    console.error("FAIL Temporary verification data cleanup; inspect this run's exact resource IDs.");
  }
  report.completedAt = new Date().toISOString();
  await mkdir(join(root, "output"), { recursive: true });
  await writeFile(join(root, "output/verification-api.json"), `${JSON.stringify(report, null, 2)}\n`);
  await database.$disconnect();
}

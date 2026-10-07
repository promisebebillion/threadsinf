import assert from "node:assert/strict";

const callbackUrl = process.env.VERIFY_CALLBACK_URL ||
  "https://asglentznxfmjtnydijr.supabase.co/functions/v1/threads-oauth-callback";
const state = "a".repeat(64);
const checks = [
  { name: "Rejects callback without state", query: { code: "verification-only" }, status: 400 },
  { name: "Rejects callback without code or error", query: { state }, status: 400 },
  { name: "Returns authorization code to the fixed local API", query: { state, code: "verification-only", returnTo: "https://example.com/" }, status: 302, code: "verification-only" },
  { name: "Returns cancellation to the fixed local API", query: { state, error: "access_denied" }, status: 302, error: "access_denied" },
];
for (const check of checks) {
  const url = new URL(callbackUrl);
  url.search = new URLSearchParams(check.query).toString();
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, check.status, check.name);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  if (response.status === 302) {
    const location = new URL(response.headers.get("location"));
    assert.equal(location.origin, "http://localhost:3000");
    assert.equal(location.pathname, "/api/accounts/oauth/callback");
    assert.equal(location.searchParams.get("state"), state);
    assert.equal(location.searchParams.get("code"), check.code ?? null);
    assert.equal(location.searchParams.get("error"), check.error ?? null);
    assert.equal(location.searchParams.has("returnTo"), false);
  }
  console.log(`PASS ${check.name}`);
}
console.log("4 live Supabase HTTPS callback checks passed; no OAuth or publication performed.");

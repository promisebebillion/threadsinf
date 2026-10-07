/// <reference lib="deno.ns" />

// This HTTPS callback returns local development authorization to the user's backend.
// Token exchange and session/state verification happen only in the local API.
Deno.serve((request: Request) => {
  const headers = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: "GET" } });
  }
  const query = new URL(request.url).searchParams;
  const state = query.get("state");
  const code = query.get("code");
  const error = query.get("error");
  if (!state || !/^[a-f0-9]{64}$/.test(state) ||
      (!code && !error) || (code && code.length > 4096) || (error && error.length > 100)) {
    return new Response("Start account connection from ThreadFlow first.", { status: 400, headers });
  }
  const target = new URL("http://localhost:3000/api/accounts/oauth/callback");
  target.searchParams.set("state", state);
  if (error) target.searchParams.set("error", error);
  else if (code) target.searchParams.set("code", code);
  return new Response(null, { status: 302, headers: { ...headers, Location: target.href } });
});

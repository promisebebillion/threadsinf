import { Router } from "express";
import { z } from "zod";
import { prisma } from "./db.js";
import { config, metaConfiguration } from "./config.js";
import { encryptToken, hashToken, randomToken } from "./security.js";
import {
  metaProvider,
  ProviderError,
  type ProviderConnection,
} from "./providers.js";
import { publicAccount } from "./serialize.js";
import { currentUser, HttpError, requestId, requireAuth } from "./http.js";
import { browserConfiguration, browserSessions, normalizeUsername } from "./browser-sessions.js";
import type { Request } from "express";
import { checkSavedProxy, editProxy, publicProxy, saveProxy, proxyInputSchema } from "./account-proxies.js";

export const accountsRouter = Router();
accountsRouter.use(requireAuth);
accountsRouter.get("/provider", (_request, response) => {
  response.json(config.THREADS_PROVIDER === "browser" ? browserConfiguration() : metaConfiguration());
});
// Proxy assignments also exist before the first login, so failed/cancelled
// logins never silently release an endpoint to a different profile.
accountsRouter.get("/proxies", async (request, response) => {
  response.json((await prisma.accountProxy.findMany({ where: { userId: currentUser(request).id }, orderBy: { username: "asc" } })).map(publicProxy));
});
function proxyOwner(request: Request) {
  return { userId: currentUser(request).id, username: normalizeUsername(String(request.params.username ?? "")) };
}
accountsRouter.put("/proxies/:username", async (request, response) => {
  response.json(await saveProxy(proxyOwner(request), request.body));
});
accountsRouter.post("/proxies/:username/check", async (request, response) => {
  z.object({}).strict().parse(request.body ?? {});
  response.json(await checkSavedProxy(proxyOwner(request)));
});
accountsRouter.delete("/proxies/:username", async (request, response) => {
  const owner = proxyOwner(request);
  await editProxy(owner, async () => {
    await prisma.accountProxy.deleteMany({ where: owner });
  });
  response.status(204).end();
});
accountsRouter.get("/", async (request, response) => {
  const accounts = await prisma.socialAccount.findMany({
    where: { userId: currentUser(request).id, provider: { in: ["meta", "browser"] } },
    orderBy: { createdAt: "asc" },
  });
  response.json(accounts.map(publicAccount));
});

async function saveConnection(
  userId: string,
  connection: ProviderConnection,
  reconnectId?: string,
) {
  if (reconnectId) {
    const original = await prisma.socialAccount.findFirst({
      where: { id: reconnectId, userId },
    });
    if (
      !original ||
      original.provider !== "meta" ||
      original.providerAccountId !== connection.account.id
    )
      throw new HttpError(
        409,
        "Reconnect the same Threads account. Use Connect account to add another one.",
      );
  }
  const data = {
    username: connection.account.username,
    displayName: connection.account.displayName,
    avatarUrl: connection.account.avatarUrl,
    accessToken: encryptToken(connection.accessToken),
    tokenExpiresAt: connection.expiresAt,
    status: "connected",
  };
  return prisma.socialAccount.upsert({
    where: {
      userId_provider_providerAccountId: {
        userId,
        provider: "meta",
        providerAccountId: connection.account.id,
      },
    },
    create: {
      userId,
      provider: "meta",
      providerAccountId: connection.account.id,
      ...data,
    },
    update: data,
  });
}

async function oauthAuthorization(
  userId: string,
  sessionId: string,
  reconnectId?: string,
) {
  const state = randomToken();
  const readiness = metaConfiguration();
  if (!readiness.configured)
    throw new HttpError(
      503,
      `Configure the Threads connection first: ${readiness.missing.join(", ")}.`,
    );
  const authorizationUrl = metaProvider.authorizationUrl(state);
  await prisma.oAuthState.create({
    data: {
      userId,
      sessionId,
      reconnectId,
      stateHash: hashToken(state),
      expiresAt: new Date(Date.now() + 10 * 60000),
    },
  });
  return { authorizationUrl };
}

accountsRouter.post("/connect", async (request, response) => {
  const user = currentUser(request);
  if (!request.currentSession)
    throw new HttpError(401, "Sign in to connect an account.");
  if (config.THREADS_PROVIDER === "browser") {
    const input = z.object({ username: z.string().transform(normalizeUsername), proxy: proxyInputSchema.optional() }).strict().parse(request.body);
    if (input.proxy) await saveProxy({ userId: user.id, username: input.username }, input.proxy);
    response.json(await browserSessions.start(connectionOwner(request), undefined, input.username));
    return;
  }
  z.object({}).strict().parse(request.body ?? {});
  response.json(await oauthAuthorization(user.id, request.currentSession.id));
});

function connectionOwner(request: Request) {
  if (!request.currentSession) throw new HttpError(401, "Sign in to connect an account.");
  return { userId: currentUser(request).id, sessionId: request.currentSession.id };
}
accountsRouter.get("/connections/:id", async (request, response) => {
  response.json(await browserSessions.get(connectionOwner(request), requestId(request)));
});
accountsRouter.post("/connections/:id/save", async (request, response) => {
  const input = z.object({ username: z.string().transform(normalizeUsername) }).strict().parse(request.body);
  response.json(await browserSessions.save(connectionOwner(request), requestId(request), input.username));
});
accountsRouter.post("/connections/:id/cancel", async (request, response) => {
  z.object({}).strict().parse(request.body ?? {});
  response.json(await browserSessions.cancel(connectionOwner(request), requestId(request)));
});

accountsRouter.post("/connect-token", async (request, response) => {
  const input = z
    .object({
      accessToken: z.string().trim()
        .min(20, "Paste a complete Threads user access token from your Meta app.")
        .max(8192, "This token is too long. Use a Threads user access token."),
    })
    .strict()
    .parse(request.body);
  const connection = await metaProvider.connectWithToken(input.accessToken);
  response
    .status(201)
    .json(publicAccount(await saveConnection(currentUser(request).id, connection)));
});

accountsRouter.get("/oauth/callback", async (request, response) => {
  const query = z
    .object({
      state: z.string().regex(/^[a-f0-9]{64}$/),
      code: z.string().max(4096).optional(),
      error: z.string().max(100).optional(),
      error_description: z.string().max(1000).optional(),
      error_reason: z.string().max(100).optional(),
    })
    .parse(request.query);
  const user = currentUser(request);
  const state = await prisma.$transaction(async (transaction) => {
    const saved = await transaction.oAuthState.findUnique({
      where: { stateHash: hashToken(query.state) },
    });
    if (
      !saved ||
      saved.userId !== user.id ||
      saved.sessionId !== request.currentSession?.id ||
      saved.expiresAt <= new Date()
    )
      throw new HttpError(
        400,
        "This connection link has expired. Start again.",
      );
    const consumed = await transaction.oAuthState.deleteMany({
      where: { id: saved.id },
    });
    if (!consumed.count)
      throw new HttpError(400, "This connection link has already been used.");
    return saved;
  });
  const redirect = new URL("/accounts", config.FRONTEND_URL);
  if (query.error || !query.code) {
    redirect.searchParams.set("oauth", "cancelled");
    response.redirect(redirect.toString());
    return;
  }
  try {
    const connection = await metaProvider.connectAccount(query.code);
    await saveConnection(user.id, connection, state.reconnectId ?? undefined);
    redirect.searchParams.set("oauth", "connected");
  } catch (error) {
    if (!(error instanceof ProviderError) && !(error instanceof HttpError))
      throw error;
    redirect.searchParams.set("oauth", "failed");
    redirect.searchParams.set(
      "oauth_message",
      error instanceof HttpError ? error.userMessage : error.message,
    );
  }
  response.redirect(redirect.toString());
});

accountsRouter.post("/:id/reconnect", async (request, response) => {
  z.object({}).strict().parse(request.body ?? {});
  const user = currentUser(request);
  const account = await prisma.socialAccount.findFirst({
    where: { id: requestId(request), userId: user.id, provider: { in: ["meta", "browser"] } },
  });
  if (!account) throw new HttpError(404, "Account not found.");
  if (!request.currentSession)
    throw new HttpError(401, "Sign in to reconnect an account.");
  response.json(
    account.provider === "browser"
      ? await browserSessions.start(connectionOwner(request), { id: account.id, providerAccountId: account.providerAccountId }, account.username)
      : await oauthAuthorization(user.id, request.currentSession.id, account.id),
  );
});

accountsRouter.post("/:id/open", async (request, response) => {
  z.object({}).strict().parse(request.body ?? {});
  const account = await prisma.socialAccount.findFirst({ where: { id: requestId(request), userId: currentUser(request).id, provider: "browser" } });
  if (!account) throw new HttpError(404, "Saved Threads session not found.");
  await browserSessions.open(connectionOwner(request), account);
  response.json({ status: "opened" });
});
accountsRouter.post("/:id/verify", async (request, response) => {
  z.object({}).strict().parse(request.body ?? {});
  const account = await prisma.socialAccount.findFirst({ where: { id: requestId(request), userId: currentUser(request).id, provider: "browser" } });
  if (!account) throw new HttpError(404, "Saved Threads session not found.");
  response.json(await browserSessions.verify(connectionOwner(request), account));
});

accountsRouter.delete("/:id", async (request, response) => {
  const account = await prisma.socialAccount.findFirst({
    where: {
      id: requestId(request),
      userId: currentUser(request).id,
      provider: { in: ["meta", "browser"] },
    },
  });
  if (!account) throw new HttpError(404, "Account not found.");
  await browserSessions.disconnectAccount(currentUser(request).id, account.id, async () => {
    await prisma.$transaction(async (transaction) => {
      await transaction.socialAccount.update({
        where: { id: account.id },
        data: { updatedAt: new Date() },
      });
      const publishing = await transaction.postTarget.count({
        where: { socialAccountId: account.id, status: "publishing" },
      });
      if (publishing)
        throw new HttpError(
          409,
          "Wait for the current publication to finish before disconnecting.",
        );
      await transaction.socialAccount.update({
        where: { id: account.id },
        data: {
          status: "disconnected",
          accessToken: null,
          refreshToken: null,
          tokenExpiresAt: null,
          sessionVerifiedAt: null,
          sessionVerificationStatus: "unknown",
          sessionVerificationError: null,
        },
      });
    });
  });
  response.status(204).end();
});

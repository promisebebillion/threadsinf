import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { config, metaConfiguration } from "./config.js";
import { prisma } from "./db.js";
import { authRouter } from "./auth.js";
import { accountsRouter } from "./accounts.js";
import { postsRouter } from "./posts.js";
import {
  currentUser,
  HttpError,
  requireAuth,
  requireMutationOrigin,
} from "./http.js";
import { dateSchema } from "./validation.js";
import { postInclude, publicPost } from "./serialize.js";
import { ProviderError } from "./providers.js";
import { browserConfiguration } from "./browser-sessions.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("query parser", "simple");
  if (config.TRUST_PROXY_HOPS > 0)
    app.set("trust proxy", config.TRUST_PROXY_HOPS);
  app.use(helmet({ strictTransportSecurity: false }));
  app.use(
    cors({
      origin: (origin, callback) => callback(null, !origin || config.frontendOrigins.has(origin)),
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["content-type", "x-threadflow-client"],
    }),
  );
  app.use(express.json({ limit: "32kb" }));
  app.use(cookieParser());
  app.use(requireMutationOrigin);
  app.use(
    "/api",
    rateLimit({
      windowMs: 60000,
      limit: config.NODE_ENV === "test" ? 10000 : 500,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "Too many requests. Try again in a minute." },
    }),
  );
  app.use("/api", (_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  app.get("/api/health", async (_request, response) => {
    await prisma.$queryRaw`SELECT 1`;
    response.json({
      status: "ok",
      provider: config.THREADS_PROVIDER,
      database: "supabase",
      sessionLoginConfigured: browserConfiguration().configured,
      oauthConfigured: metaConfiguration().configured,
    });
  });
  app.use("/api/auth", authRouter);
  app.get("/api/provider", requireAuth, (_request, response) => {
    response.json(config.THREADS_PROVIDER === "browser" ? browserConfiguration() : metaConfiguration());
  });
  app.use("/api/accounts", accountsRouter);
  app.use("/api/posts", postsRouter);
  app.get("/api/calendar", requireAuth, async (request, response) => {
    const query = z
      .object({ start: dateSchema, end: dateSchema })
      .strict()
      .parse(request.query);
    if (
      query.end <= query.start ||
      query.end.getTime() - query.start.getTime() > 400 * 86400000
    )
      throw new HttpError(400, "Choose a calendar range of up to 400 days.");
    const posts = await prisma.post.findMany({
      where: {
        userId: currentUser(request).id,
        status: { notIn: ["draft", "cancelled"] },
        scheduledAt: { gte: query.start, lt: query.end },
      },
      include: postInclude,
      orderBy: { scheduledAt: "asc" },
    });
    response.json(posts.map(publicPost));
  });
  app.get("/api/dashboard", requireAuth, async (request, response) => {
    const userId = currentUser(request).id;
    const [
      connectedAccounts,
      scheduledPosts,
      publishedPosts,
      failedPosts,
      upcoming,
      recent,
    ] = await Promise.all([
      prisma.socialAccount.count({
        where: {
          userId,
          status: "connected",
          OR: [
            { tokenExpiresAt: null },
            { tokenExpiresAt: { gt: new Date() } },
          ],
          AND: [{ OR: [{ provider: "meta" }, { provider: "browser", sessionVerificationStatus: "verified" }] }],
        },
      }),
      prisma.post.count({
        where: { userId, status: { in: ["scheduled", "publishing"] } },
      }),
      prisma.post.count({ where: { userId, status: "published" } }),
      prisma.post.count({ where: { userId, status: { in: ["failed", "unconfirmed"] } } }),
      prisma.post.findMany({
        where: { userId, status: { in: ["scheduled", "publishing"] } },
        include: postInclude,
        orderBy: { scheduledAt: "asc" },
        take: 5,
      }),
      prisma.post.findMany({
        where: { userId, status: { in: ["published", "failed", "unconfirmed"] } },
        include: postInclude,
        orderBy: { updatedAt: "desc" },
        take: 5,
      }),
    ]);
    response.json({
      connectedAccounts,
      scheduledPosts,
      publishedPosts,
      failedPosts,
      upcomingPosts: upcoming.map(publicPost),
      recentPosts: recent.map(publicPost),
    });
  });
  app.use((_request, _response, next) => {
    next(new HttpError(404, "This route was not found."));
  });

  const errorHandler: ErrorRequestHandler = (
    error: unknown,
    _request,
    response,
    _next,
  ) => {
    if (error instanceof HttpError) {
      response.status(error.status).json({ error: error.userMessage });
      return;
    }
    if (error instanceof z.ZodError) {
      const message =
        error.issues[0]?.message ?? "Check the fields and try again.";
      response.status(400).json({ error: message, details: error.flatten() });
      return;
    }
    if (error instanceof ProviderError) {
      response.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2002") {
        response.status(409).json({ error: "This record already exists." });
        return;
      }
      if (error.code === "P2025") {
        response
          .status(404)
          .json({ error: "The requested record was not found." });
        return;
      }
      console.error("Database request failed", { code: error.code });
      response
        .status(503)
        .json({ error: "The database is temporarily unavailable. Try again." });
      return;
    }
    if (error instanceof SyntaxError) {
      response
        .status(400)
        .json({ error: "The request must contain valid JSON." });
      return;
    }
    const oversized = z
      .object({ type: z.literal("entity.too.large") })
      .safeParse(error);
    if (oversized.success) {
      response.status(413).json({ error: "The request is too large." });
      return;
    }
    console.error("Unhandled API error", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    response.status(500).json({ error: "Something went wrong. Try again." });
  };
  app.use(errorHandler);
  return app;
}

import { prisma } from "./db.js";
import { config } from "./config.js";
import { decryptToken, encryptToken, randomToken } from "./security.js";
import { ProviderError, metaProvider, type PublishInput } from "./providers.js";
import { browserProvider } from "./browser-publishing.js";

const MAX_ATTEMPTS = 3;
const CLAIM_TTL_MS = 5 * 60000;
const TOKEN_REFRESH_INTERVAL_MS = 10 * 60000;
let running = false;
let lastTokenRefreshCheckAt = 0;

export function aggregateStatus(statuses: string[]): string {
  if (statuses.every((status) => status === "published")) return "published";
  if (statuses.some((status) => status === "publishing")) return "publishing";
  if (statuses.some((status) => status === "scheduled")) return "scheduled";
  if (statuses.some((status) => status === "unconfirmed")) return "unconfirmed";
  if (statuses.some((status) => status === "failed")) return "failed";
  if (statuses.every((status) => status === "cancelled")) return "cancelled";
  return "draft";
}

async function updatePostStatus(postId: string) {
  await prisma.$transaction(async (transaction) => {
    const parent = await transaction.post.updateMany({
      where: { id: postId, status: { not: "cancelled" } },
      data: { updatedAt: new Date() },
    });
    if (!parent.count) return;
    const targets = await transaction.postTarget.findMany({
      where: { postId },
      select: { status: true },
    });
    const status = aggregateStatus(targets.map((target) => target.status));
    await transaction.post.update({ where: { id: postId }, data: { status } });
  });
}

async function recoverClaims() {
  const stale = await prisma.postTarget.findMany({
    where: { status: "publishing", claimExpiresAt: { lte: new Date() } },
  });
  for (const target of stale) {
    const uncertain = Boolean(target.publishStartedAt);
    const terminal = uncertain || target.retryCycleAttempts >= MAX_ATTEMPTS;
    const update = await prisma.postTarget.updateMany({
      where: {
        id: target.id,
        claimToken: target.claimToken,
        status: "publishing",
        claimExpiresAt: { lte: new Date() },
      },
      data: {
        status: uncertain ? "unconfirmed" : terminal ? "failed" : "scheduled",
        nextAttemptAt: terminal ? null : new Date(),
        claimToken: null,
        claimExpiresAt: null,
        publishUncertain: uncertain,
        errorMessage: uncertain
          ? "The worker stopped while Threads was publishing. Verify the post on Threads before creating another publication."
          : terminal
            ? "The worker stopped after the final attempt. Retry this post when ready."
            : "The worker restarted. Publication will resume automatically.",
      },
    });
    if (update.count) await updatePostStatus(target.postId);
  }
}

async function publishTarget(id: string) {
  const claimToken = randomToken();
  const target = await prisma.$transaction(async (transaction) => {
    const candidate = await transaction.postTarget.findUnique({
      where: { id },
      include: { post: true },
    });
    if (
      !candidate ||
      candidate.post.status === "cancelled" ||
      candidate.status !== "scheduled" ||
      !candidate.nextAttemptAt ||
      candidate.nextAttemptAt > new Date() ||
      candidate.retryCycleAttempts >= MAX_ATTEMPTS
    )
      return null;
    // Parent locking also serializes edits/cancellation against target claiming.
    const parent = await transaction.post.updateMany({
      where: {
        id: candidate.postId,
        status: { in: ["scheduled", "publishing"] },
      },
      data: { status: "publishing" },
    });
    if (!parent.count) return null;
    await transaction.socialAccount.update({
      where: { id: candidate.socialAccountId },
      data: { updatedAt: new Date() },
    });
    const claimed = await transaction.postTarget.updateMany({
      where: {
        id,
        status: "scheduled",
        nextAttemptAt: { lte: new Date() },
        retryCycleAttempts: { lt: MAX_ATTEMPTS },
      },
      data: {
        status: "publishing",
        claimToken,
        claimExpiresAt: new Date(Date.now() + CLAIM_TTL_MS),
        attempts: { increment: 1 },
        retryCycleAttempts: { increment: 1 },
        lastAttemptAt: new Date(),
      },
    });
    if (!claimed.count) return null;
    return transaction.postTarget.findUnique({
      where: { id },
      include: { post: true, socialAccount: true },
    });
  });
  if (!target) return;
  let savedToken = target.socialAccount.accessToken;
  try {
    const account = target.socialAccount;
    if (!["meta", "browser"].includes(account.provider))
      throw new ProviderError("Reconnect this account using a supported connection.");
    if (account.status !== "connected" || !account.accessToken)
      throw new ProviderError(
        "This account is disconnected. Reconnect it before retrying.",
      );
    if (account.tokenExpiresAt && account.tokenExpiresAt <= new Date())
      throw new ProviderError(
        "Threads authorization expired. Reconnect this account.",
        { authExpired: true },
      );
    let accessToken = decryptToken(account.accessToken);
    if (
      account.provider === "meta" && account.tokenExpiresAt &&
      account.tokenExpiresAt.getTime() - Date.now() < 7 * 86400000
    ) {
      try {
        const refreshed = await metaProvider.refreshToken(accessToken);
        accessToken = refreshed.accessToken;
        const encrypted = encryptToken(accessToken);
        const updated = await prisma.socialAccount.updateMany({
          where: {
            id: account.id,
            accessToken: account.accessToken,
            status: "connected",
          },
          data: {
            accessToken: encrypted,
            tokenExpiresAt: refreshed.expiresAt,
          },
        });
        if (updated.count) savedToken = encrypted;
      } catch (error) {
        if (!(error instanceof ProviderError) || error.authExpired) throw error;
        // A valid imported short-lived token may not support refresh. It can still publish until expiry.
      }
    }
    const input: PublishInput = {
      accountId: account.providerAccountId,
      accessToken,
      content: target.post.content,
      containerId: target.containerId,
      saveContainer: async (containerId) => {
        const saved = await prisma.postTarget.updateMany({
          where: { id, claimToken, status: "publishing" },
          data: { containerId },
        });
        if (!saved.count) throw new ProviderError("Publication claim expired before sending. Publication can retry.", { retryable: true });
      },
      markPublishStarted: async () => {
        const saved = await prisma.$transaction(async (transaction) => {
          const active = await transaction.socialAccount.updateMany({
            where: { id: account.id, status: "connected", accessToken: savedToken },
            data: { updatedAt: new Date() },
          });
          if (!active.count)
            throw new ProviderError("This account changed before sending. Check its session before retrying.");
          return transaction.postTarget.updateMany({
            where: { id, claimToken, status: "publishing", claimExpiresAt: { gt: new Date() } },
            data: { publishStartedAt: new Date() },
          });
        });
        if (!saved.count) throw new ProviderError("Publication claim expired before sending. Publication can retry.", { retryable: true });
      },
    };
    const result = account.provider === "browser"
      ? await browserProvider.publishPost({
          ...input,
          username: account.username,
          userId: account.userId,
          socialAccountId: account.id,
          loadSession: async () => {
            const renewed = await prisma.postTarget.updateMany({
              where: { id, claimToken, status: "publishing", claimExpiresAt: { gt: new Date() }, publishStartedAt: null },
              data: { claimExpiresAt: new Date(Date.now() + CLAIM_TTL_MS) },
            });
            if (!renewed.count)
              throw new ProviderError("Publication claim expired before sending. Publication can retry.", { retryable: true });
            const latest = await prisma.socialAccount.findUnique({ where: { id: account.id } });
            if (!latest || latest.userId !== account.userId || latest.provider !== "browser" ||
                latest.providerAccountId !== account.providerAccountId || latest.username !== account.username)
              throw new ProviderError("This profile changed while waiting. Choose the correct account before retrying.");
            if (latest.status !== "connected" || !latest.accessToken)
              throw new ProviderError("This account is disconnected. Reconnect it before retrying.");
            savedToken = latest.accessToken;
            if (latest.tokenExpiresAt && latest.tokenExpiresAt <= new Date())
              throw new ProviderError("The saved Threads session expired. Reconnect this account.",
                { authExpired: true, sessionVerificationStatus: "expired" });
            return decryptToken(latest.accessToken);
          },
          saveSession: async (sessionJSON) => {
            const encrypted = encryptToken(sessionJSON);
            const saved = await prisma.socialAccount.updateMany({
              where: { id: account.id, accessToken: savedToken, status: "connected" },
              data: {
                accessToken: encrypted,
                sessionVerifiedAt: new Date(),
                sessionVerificationStatus: "verified",
                sessionVerificationError: null,
              },
            });
            if (!saved.count)
              throw new ProviderError("This account changed during preparation. Check its session before retrying.");
            savedToken = encrypted;
          },
        })
      : await metaProvider.publishPost(input);
    await prisma.postTarget.updateMany({
      where: { id, claimToken },
      data: {
        status: "published",
        externalPostId: result.externalPostId,
        publishedAt: new Date(),
        errorMessage: null,
        nextAttemptAt: null,
        claimToken: null,
        claimExpiresAt: null,
        publishUncertain: false,
      },
    });
  } catch (error) {
    const stored = await prisma.postTarget.findUnique({
      where: { id },
      select: { publishStartedAt: true },
    });
    const uncertain = Boolean(stored?.publishStartedAt);
    const failure =
      error instanceof ProviderError
        ? error
        : new ProviderError(
            uncertain
              ? "Threads may have published this post. Verify it on Threads before posting again."
              : "Publication could not be completed. Try again after checking the account.",
            { uncertain },
          );
    const retry =
      failure.retryable &&
      !failure.uncertain && !uncertain &&
      target.retryCycleAttempts < MAX_ATTEMPTS;
    if (failure.authExpired || (target.socialAccount.provider === "browser" && failure.sessionVerificationStatus))
      await prisma.socialAccount.updateMany({
        where: { id: target.socialAccountId, accessToken: savedToken, status: { not: "disconnected" } },
        data: {
          ...(failure.authExpired ? { status: "expired" } : {}),
          ...(target.socialAccount.provider === "browser" ? {
            sessionVerificationStatus: failure.sessionVerificationStatus ?? (failure.authExpired ? "expired" : "unknown"),
            sessionVerificationError: failure.message,
          } : {}),
        },
      });
    await prisma.postTarget.updateMany({
      where: { id, claimToken },
      data: {
        status: failure.uncertain || uncertain ? "unconfirmed" : retry ? "scheduled" : "failed",
        errorMessage: failure.message,
        nextAttemptAt: retry
          ? new Date(
              Date.now() +
                config.RETRY_BASE_MS * 4 ** (target.retryCycleAttempts - 1),
            )
          : null,
        publishUncertain: failure.uncertain || uncertain,
        publishStartedAt: failure.uncertain || uncertain
          ? (stored?.publishStartedAt ?? new Date())
          : null,
        claimToken: null,
        claimExpiresAt: null,
      },
    });
  }
  await updatePostStatus(target.postId);
}

async function refreshExpiringTokens() {
  if (Date.now() - lastTokenRefreshCheckAt < TOKEN_REFRESH_INTERVAL_MS) return;
  lastTokenRefreshCheckAt = Date.now();
  const now = new Date();
  await prisma.socialAccount.updateMany({
    where: { provider: { in: ["meta", "browser"] }, status: "connected", tokenExpiresAt: { lte: now } },
    data: { status: "expired" },
  });
  const expiring = await prisma.socialAccount.findMany({
    where: {
      provider: "meta",
      status: "connected",
      accessToken: { not: null },
      tokenExpiresAt: { gt: now, lt: new Date(now.getTime() + 7 * 86400000) },
    },
    orderBy: { tokenExpiresAt: "asc" },
    take: 5,
  });
  await Promise.all(
    expiring.map(async (account) => {
      if (!account.accessToken) return;
      try {
        const refreshed = await metaProvider.refreshToken(decryptToken(account.accessToken));
        // Compare the stored token so a concurrent reconnect/disconnect cannot be overwritten.
        await prisma.socialAccount.updateMany({
          where: {
            id: account.id,
            status: "connected",
            accessToken: account.accessToken,
          },
          data: {
            accessToken: encryptToken(refreshed.accessToken),
            tokenExpiresAt: refreshed.expiresAt,
          },
        });
      } catch (error) {
        if (error instanceof ProviderError && error.authExpired) {
          await prisma.socialAccount.updateMany({
            where: {
              id: account.id,
              status: "connected",
              accessToken: account.accessToken,
            },
            data: { status: "expired" },
          });
        }
        // Temporary provider/network failures keep the account connected and retry next maintenance run.
      }
    }),
  );
}

export async function runSchedulerTick() {
  if (running) return;
  running = true;
  try {
    await recoverClaims();
    const publishingPosts = await prisma.post.findMany({
      where: { status: "publishing" },
      select: { id: true },
      take: 100,
    });
    for (const post of publishingPosts) await updatePostStatus(post.id);
    const due = await prisma.postTarget.findMany({
      where: {
        status: "scheduled",
        nextAttemptAt: { lte: new Date() },
        retryCycleAttempts: { lt: MAX_ATTEMPTS },
        post: { status: { in: ["scheduled", "publishing"] } },
      },
      orderBy: { nextAttemptAt: "asc" },
      take: 25,
      select: { id: true },
    });
    // Bounded concurrency prevents a slow remote account from blocking all due posts.
    for (let offset = 0; offset < due.length; offset += 5)
      await Promise.all(
        due.slice(offset, offset + 5).map((target) => publishTarget(target.id)),
      );
    await refreshExpiringTokens();
    await prisma.session.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    await prisma.oAuthState.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
  } finally {
    running = false;
  }
}

export function startScheduler() {
  const tick = () => {
    void runSchedulerTick().catch(() =>
      console.error(
        "Scheduler tick failed; persisted work will resume on the next tick.",
      ),
    );
  };
  const timer = setInterval(tick, config.SCHEDULER_INTERVAL_MS);
  tick();
  return () => clearInterval(timer);
}

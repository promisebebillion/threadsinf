import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "./db.js";
import { config } from "./config.js";
import { currentUser, HttpError, requestId, requireAuth } from "./http.js";
import {
  postInputSchema,
  postQuerySchema,
  rescheduleSchema,
} from "./validation.js";
import { postInclude, publicPost } from "./serialize.js";
import { runSchedulerTick } from "./scheduler.js";

export const postsRouter = Router();
postsRouter.use(requireAuth);

async function ownedPost(id: string, userId: string) {
  const post = await prisma.post.findFirst({
    where: { id, userId },
    include: postInclude,
  });
  if (!post) throw new HttpError(404, "Post not found.");
  return post;
}

async function verifyAccounts(
  userId: string,
  accountIds: string[],
  transaction: Prisma.TransactionClient = prisma,
  publishing = false,
) {
  if (publishing && !accountIds.length)
    throw new HttpError(400, "Choose a connected account before publishing.");
  const accounts = await transaction.socialAccount.findMany({
    where: { id: { in: accountIds }, userId, status: "connected" },
  });
  if (accounts.length !== accountIds.length)
    throw new HttpError(400, "Choose connected accounts from your workspace.");
  if (accounts.some((account) => account.provider !== config.THREADS_PROVIDER))
    throw new HttpError(400, "Choose accounts from the current provider mode.");
  if (
    accounts.some(
      (account) =>
        account.tokenExpiresAt && account.tokenExpiresAt <= new Date(),
    )
  )
    throw new HttpError(
      400,
      "Reconnect accounts with expired authorization before scheduling.",
    );
}

postsRouter.get("/", async (request, response) => {
  const query = postQuerySchema.parse(request.query);
  const where: Prisma.PostWhereInput = { userId: currentUser(request).id };
  if (query.status) where.status = query.status;
  if (query.accountId)
    where.targets = { some: { socialAccountId: query.accountId } };
  if (query.search) where.content = { contains: query.search };
  const posts = await prisma.post.findMany({
    where,
    include: postInclude,
    orderBy: { createdAt: "desc" },
  });
  response.json(posts.map(publicPost));
});

postsRouter.get("/:id", async (request, response) => {
  response.json(
    publicPost(await ownedPost(requestId(request), currentUser(request).id)),
  );
});

postsRouter.post("/", async (request, response) => {
  const input = postInputSchema.parse(request.body);
  const user = currentUser(request);
  const scheduledAt =
    input.status === "scheduled" ? (input.scheduledAt ?? null) : null;
  const post = await prisma.$transaction(async (transaction) => {
    await verifyAccounts(user.id, input.accountIds, transaction, input.status === "scheduled");
    return transaction.post.create({
      data: {
        userId: user.id,
        content: input.content,
        status: input.status,
        scheduledAt,
        timezone: input.timezone,
        targets: {
          create: input.accountIds.map((socialAccountId) => ({
            socialAccountId,
            status: input.status,
            nextAttemptAt: scheduledAt,
          })),
        },
      },
      include: postInclude,
    });
  });
  response.status(201).json(publicPost(post));
});

postsRouter.patch("/:id", async (request, response) => {
  const input = postInputSchema.parse(request.body);
  const user = currentUser(request);
  const id = requestId(request);
  await ownedPost(id, user.id);
  const scheduledAt =
    input.status === "scheduled" ? (input.scheduledAt ?? null) : null;
  const post = await prisma.$transaction(async (transaction) => {
    const locked = await transaction.post.updateMany({
      where: {
        id,
        userId: user.id,
        status: { in: ["draft", "scheduled", "failed"] },
      },
      data: { updatedAt: new Date() },
    });
    if (!locked.count)
      throw new HttpError(409, "This post can no longer be edited.");
    const targets = await transaction.postTarget.findMany({
      where: { postId: id },
    });
    const irreversible = targets.some(
      (target) =>
        target.status === "published" ||
        target.status === "publishing" ||
        target.publishUncertain,
    );
    if (irreversible)
      throw new HttpError(
        409,
        "A published or unconfirmed post cannot be edited.",
      );
    await verifyAccounts(user.id, input.accountIds, transaction, input.status === "scheduled");
    await transaction.postTarget.deleteMany({ where: { postId: id } });
    return transaction.post.update({
      where: { id },
      data: {
        content: input.content,
        status: input.status,
        scheduledAt,
        timezone: input.timezone,
        targets: {
          create: input.accountIds.map((socialAccountId) => ({
            socialAccountId,
            status: input.status,
            nextAttemptAt: scheduledAt,
          })),
        },
      },
      include: postInclude,
    });
  });
  response.json(publicPost(post));
});

postsRouter.post("/:id/publish-now", async (request, response) => {
  const user = currentUser(request);
  const id = requestId(request);
  await ownedPost(id, user.id);
  const post = await prisma.$transaction(async (transaction) => {
    const locked = await transaction.post.updateMany({
      where: {
        id,
        userId: user.id,
        status: { in: ["draft", "scheduled", "failed"] },
      },
      data: { updatedAt: new Date() },
    });
    if (!locked.count)
      throw new HttpError(
        409,
        "This post is already publishing, published, or cancelled.",
      );
    const targets = await transaction.postTarget.findMany({
      where: { postId: id },
    });
    if (
      targets.some(
        (target) => target.publishUncertain || target.status === "publishing",
      )
    )
      throw new HttpError(
        409,
        "Verify the unconfirmed publication on Threads before creating another post.",
      );
    const pending = targets.filter((target) => target.status !== "published");
    await verifyAccounts(
      user.id,
      pending.map((target) => target.socialAccountId),
      transaction,
      true,
    );
    const now = new Date();
    await transaction.postTarget.updateMany({
      where: { postId: id, status: { not: "published" } },
      data: {
        status: "scheduled",
        nextAttemptAt: now,
        retryCycleAttempts: 0,
        errorMessage: null,
        claimToken: null,
        claimExpiresAt: null,
      },
    });
    return transaction.post.update({
      where: { id },
      data: { status: "scheduled", scheduledAt: now },
      include: postInclude,
    });
  });
  response.json(publicPost(post));
  void runSchedulerTick().catch(() =>
    console.error("Immediate publication deferred to the persisted scheduler."),
  );
});

postsRouter.post("/:id/reschedule", async (request, response) => {
  const input = rescheduleSchema.parse(request.body);
  const user = currentUser(request);
  const id = requestId(request);
  await ownedPost(id, user.id);
  const post = await prisma.$transaction(async (transaction) => {
    const locked = await transaction.post.updateMany({
      where: {
        id,
        userId: user.id,
        status: { in: ["draft", "scheduled", "failed"] },
      },
      data: { updatedAt: new Date() },
    });
    if (!locked.count)
      throw new HttpError(409, "This post can no longer be rescheduled.");
    const targets = await transaction.postTarget.findMany({
      where: { postId: id },
    });
    if (
      targets.some(
        (target) =>
          target.status === "publishing" ||
          target.status === "published" ||
          target.publishUncertain,
      )
    )
      throw new HttpError(
        409,
        "A published or unconfirmed post cannot be rescheduled.",
      );
    await verifyAccounts(
      user.id,
      targets.map((target) => target.socialAccountId),
      transaction,
      true,
    );
    await transaction.postTarget.updateMany({
      where: { postId: id },
      data: {
        status: "scheduled",
        nextAttemptAt: input.scheduledAt,
        retryCycleAttempts: 0,
        errorMessage: null,
      },
    });
    return transaction.post.update({
      where: { id },
      data: {
        status: "scheduled",
        scheduledAt: input.scheduledAt,
        timezone: input.timezone,
      },
      include: postInclude,
    });
  });
  response.json(publicPost(post));
});

postsRouter.delete("/:id", async (request, response) => {
  const user = currentUser(request);
  const id = requestId(request);
  await ownedPost(id, user.id);
  await prisma.$transaction(async (transaction) => {
    const locked = await transaction.post.updateMany({
      where: {
        id,
        userId: user.id,
        status: { in: ["draft", "scheduled", "failed", "cancelled"] },
      },
      data: { status: "cancelled" },
    });
    if (!locked.count)
      throw new HttpError(
        409,
        "Wait for publishing to finish. Published posts cannot be cancelled.",
      );
    const active = await transaction.postTarget.count({
      where: { postId: id, status: "publishing" },
    });
    if (active)
      throw new HttpError(
        409,
        "Wait for publishing to finish before cancelling.",
      );
    await transaction.postTarget.updateMany({
      where: { postId: id, status: { not: "published" } },
      data: {
        status: "cancelled",
        nextAttemptAt: null,
        claimToken: null,
        claimExpiresAt: null,
      },
    });
  });
  response.status(204).end();
});

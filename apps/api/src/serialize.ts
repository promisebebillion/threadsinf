import type {
  User as DbUser,
  SocialAccount as DbAccount,
  Prisma,
} from "@prisma/client";
import type { User, SocialAccount, Post } from "@threadflow/shared";

export const postInclude = {
  targets: {
    include: { socialAccount: true },
    orderBy: { id: "asc" as const },
  },
} satisfies Prisma.PostInclude;
export type FullPost = Prisma.PostGetPayload<{ include: typeof postInclude }>;
export function publicUser(user: DbUser): User {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    timezone: user.timezone,
    createdAt: user.createdAt.toISOString(),
  };
}
export function publicAccount(account: DbAccount): SocialAccount {
  const status =
    account.status === "connected" &&
    account.tokenExpiresAt &&
    account.tokenExpiresAt <= new Date()
      ? "expired"
      : account.status;
  return {
    id: account.id,
    provider: account.provider as SocialAccount["provider"],
    providerAccountId: account.providerAccountId,
    username: account.username,
    displayName: account.displayName,
    avatarUrl: account.avatarUrl,
    status: status as SocialAccount["status"],
    tokenExpiresAt: account.tokenExpiresAt?.toISOString() ?? null,
    createdAt: account.createdAt.toISOString(),
    sessionVerifiedAt: account.sessionVerifiedAt?.toISOString() ?? null,
    sessionVerificationStatus: account.sessionVerificationStatus as SocialAccount["sessionVerificationStatus"],
    sessionVerificationError: account.sessionVerificationError,
  };
}
export function publicPost(post: FullPost): Post {
  return {
    id: post.id,
    content: post.content,
    status: post.status as Post["status"],
    timezone: post.timezone,
    scheduledAt: post.scheduledAt?.toISOString() ?? null,
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
    targets: post.targets.map((target) => ({
      id: target.id,
      socialAccountId: target.socialAccountId,
      account: publicAccount(target.socialAccount),
      status: target.status as Post["status"],
      externalPostId: target.externalPostId,
      publishedAt: target.publishedAt?.toISOString() ?? null,
      attempts: target.attempts,
      lastAttemptAt: target.lastAttemptAt?.toISOString() ?? null,
      errorMessage: target.errorMessage,
      publishUncertain: target.publishUncertain,
    })),
  };
}

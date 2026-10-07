import dotenv from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
dotenv.config({ path: join(root, "apps/api/.env"), quiet: true });
const { prisma } = await import("../apps/api/src/db.js");
const { browserSessions } = await import("../apps/api/src/browser-sessions.js");

try {
  const accounts = await prisma.socialAccount.findMany({
    where: { provider: "browser", status: { not: "disconnected" } },
  });
  const checks = [];
  for (const account of accounts) {
    const platformSession = await prisma.session.findFirst({
      where: { userId: account.userId, expiresAt: { gt: new Date() } },
      select: { id: true },
    });
    if (!platformSession) {
      checks.push({ username: account.username, status: "skipped", reason: "Sign in to ThreadFlow before verifying this session." });
      continue;
    }
    const result = await browserSessions.verify({ userId: account.userId, sessionId: platformSession.id }, account);
    checks.push({ username: account.username, status: result.status, checkedAt: result.checkedAt, message: result.errorMessage ?? "Threads confirmed this exact profile." });
  }
  const report = { completedAt: new Date().toISOString(), database: "supabase", schema: "public", checks, publishedPosts: 0 };
  await mkdir(join(root, "output"), { recursive: true });
  await writeFile(join(root, "output/verification-sessions.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browserSessions.shutdown();
  await prisma.$disconnect();
}

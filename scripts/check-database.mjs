import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
dotenv.config({ path: join(root, "apps/api/.env"), quiet: true });
const database = new PrismaClient();
try {
  const tables = await database.$queryRaw`
    SELECT table_schema, table_name FROM information_schema.tables
    WHERE table_schema IN ('threadflow', 'public') ORDER BY table_schema, table_name
  `;
  console.log(JSON.stringify({ tables }, null, 2));
  if (process.argv.includes("--verify")) {
    const security = await database.$queryRaw`
      SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled,
        has_table_privilege('anon', c.oid, 'SELECT') AS anon_select,
        has_table_privilege('authenticated', c.oid, 'SELECT') AS authenticated_select
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND c.relname IN ('User','Session','OAuthState','SocialAccount','Post','PostTarget','AccountProxy') ORDER BY c.relname
    `;
    const applicationTables = security.filter(
      (row) => row.table_name !== "_prisma_migrations",
    );
    if (
      applicationTables.length !== 7 ||
      applicationTables.some(
        (row) =>
          !row.rls_enabled || row.anon_select || row.authenticated_select,
      )
    ) {
      throw new Error("Database isolation check failed.");
    }
    console.log(JSON.stringify({ security, isolated: true }, null, 2));
  }
} finally {
  await database.$disconnect();
}

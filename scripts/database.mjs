import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const api = join(root, "apps/api");
const envPath = join(api, ".env");
const envText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const databaseUrl =
  process.env.DATABASE_URL ??
  envText.match(/^DATABASE_URL\s*=\s*["']?([^\r\n"']+)/m)?.[1];
if (!databaseUrl)
  throw new Error("Configure apps/api/.env before using database commands.");
const url = new URL(databaseUrl);
if (!["postgres:", "postgresql:"].includes(url.protocol) ||
    !(url.hostname.endsWith(".supabase.co") || url.hostname.endsWith(".pooler.supabase.com"))) {
  throw new Error("DATABASE_URL must point to your Supabase database.");
}
const schema = "prisma/schema.prisma";
const commands = {
  generate: ["generate"],
  migrate: ["migrate", "deploy"],
  studio: ["studio"],
};
const command = commands[process.argv[2]];
if (!command) throw new Error("Expected generate, migrate, or studio.");
console.log("Database: Supabase");
const result = spawnSync(
  process.execPath,
  [
    join(root, "node_modules/prisma/build/index.js"),
    ...command,
    "--schema",
    schema,
  ],
  {
    cwd: api,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  },
);
process.exit(result.status ?? 1);

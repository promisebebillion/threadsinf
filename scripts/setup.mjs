import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npmCli = process.env.npm_execpath;
if (!npmCli || !existsSync(npmCli))
  throw new Error("Run setup with npm run setup.");

function npm(args) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

for (const app of ["api", "web"]) {
  const folder = join(root, "apps", app);
  const template = join(folder, ".env.example");
  const destination = join(folder, ".env");
  if (!existsSync(template))
    throw new Error(`Missing apps/${app}/.env.example`);
  if (!existsSync(destination)) {
    mkdirSync(folder, { recursive: true });
    let content = readFileSync(template, "utf8");
    if (app === "api")
      content = content.replace(
        "replace-with-64-hex-characters",
        randomBytes(32).toString("hex"),
      );
    writeFileSync(destination, content, { mode: 0o600 });
    console.log(`Created apps/${app}/.env`);
  }
}

npm(["run", "build", "-w", "@threadflow/shared"]);
const apiEnv = readFileSync(join(root, "apps/api/.env"), "utf8");
const databaseUrl =
  process.env.DATABASE_URL ??
  apiEnv.match(/^DATABASE_URL\s*=\s*["']?([^\r\n"']+)/m)?.[1];
if (!databaseUrl || !/^postgres(?:ql)?:\/\//.test(databaseUrl)) {
  throw new Error("Configure the Supabase DATABASE_URL in apps/api/.env.");
}
const schemaPath = join(root, "apps/api/prisma/schema.prisma");
const clientFolder = join(root, "node_modules/.prisma/client");
const generatedSchema = join(clientFolder, "schema.prisma");
const normalizeSchema = (source) => source.replace(/\s+/g, " ").trim();
if (
  !existsSync(join(clientFolder, "index.js")) ||
  !existsSync(generatedSchema) ||
  normalizeSchema(readFileSync(generatedSchema, "utf8")) !==
    normalizeSchema(readFileSync(schemaPath, "utf8"))
) {
  npm(["run", "db:generate"]);
} else {
  console.log("Prisma Client is up to date; generation skipped.");
}
npm(["run", "db:migrate"]);
console.log(
  "ThreadFlow is ready. Web: http://localhost:5173 · API: http://localhost:3000",
);

import "dotenv/config";
import { z } from "zod";
import type { MetaProviderInfo } from "@threadflow/shared";

function isSupabaseDatabase(value: string): boolean {
  try {
    const url = new URL(value);
    return ["postgres:", "postgresql:"].includes(url.protocol) &&
      (url.hostname.endsWith(".supabase.co") || url.hostname.endsWith(".pooler.supabase.com"));
  } catch {
    return false;
  }
}

const settings = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    DATABASE_URL: z.string().refine(isSupabaseDatabase, "DATABASE_URL must connect to Supabase PostgreSQL."),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    FRONTEND_URL: z.string().url().default("http://localhost:5173"),
    THREADS_PROVIDER: z.enum(["browser", "meta"]).default("browser"),
    PROXY_NETWORK_INTERFACE: z.string().default(""),
    TOKEN_ENCRYPTION_KEY: z
      .string()
      .regex(
        /^[a-fA-F0-9]{64}$/,
        "Run npm run setup to generate the token encryption key",
      ),
    SESSION_COOKIE_SECURE: z.enum(["true", "false"]).optional(),
    SESSION_COOKIE_SAME_SITE: z.enum(["lax", "strict", "none"]).default("lax"),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
    SCHEDULER_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60000)
      .default(3000),
    RETRY_BASE_MS: z.coerce.number().int().min(100).max(3600000).default(5000),
    META_APP_ID: z.string().default(""),
    META_APP_SECRET: z.string().default(""),
    META_REDIRECT_URI: z
      .string()
      .url()
      .default("https://asglentznxfmjtnydijr.supabase.co/functions/v1/threads-oauth-callback"),
  })
  .parse(process.env);

const frontendOrigin = new URL(settings.FRONTEND_URL).origin;
const frontendOrigins = new Set([frontendOrigin]);
if (settings.NODE_ENV !== "production") {
  const localFrontend = new URL(frontendOrigin);
  if (["localhost", "127.0.0.1"].includes(localFrontend.hostname)) {
    localFrontend.hostname = localFrontend.hostname === "localhost" ? "127.0.0.1" : "localhost";
    frontendOrigins.add(localFrontend.origin);
  }
}

export const config = {
  ...settings,
  frontendOrigin,
  frontendOrigins,
  cookieSecure:
    settings.SESSION_COOKIE_SECURE === undefined
      ? settings.NODE_ENV === "production"
      : settings.SESSION_COOKIE_SECURE === "true",
};

export function metaConfiguration(): MetaProviderInfo {
  const missing: string[] = [];
  if (!config.META_APP_ID.trim()) missing.push("META_APP_ID");
  if (!config.META_APP_SECRET.trim()) missing.push("META_APP_SECRET");
  const redirect = new URL(config.META_REDIRECT_URI);
  if (redirect.protocol !== "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname)) {
    missing.push("META_REDIRECT_URI — public HTTPS callback required");
  }
  return { provider: "meta", configured: missing.length === 0, missing, redirectUri: config.META_REDIRECT_URI };
}
if (config.SESSION_COOKIE_SAME_SITE === "none" && !config.cookieSecure)
  throw new Error("SameSite=None requires secure HTTPS cookies");
if (config.NODE_ENV === "production" && !config.cookieSecure)
  throw new Error("Production sessions require secure HTTPS cookies");

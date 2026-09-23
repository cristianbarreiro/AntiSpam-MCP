import { readFileSync } from "node:fs";
import { config as dotenv } from "dotenv";
import { z } from "zod";
import { AppError } from "../../../packages/core/src/errors.js";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  MAIL_PROVIDER: z.enum(["mock", "gmail"]).default("mock"),
  DATABASE_PATH: z.string().min(1).default(".data/inboxguardian.sqlite"),
  PORT: z.coerce.number().int().min(1024).max(65535).default(4317),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().default("http://127.0.0.1:4318/oauth/callback"),
  GOOGLE_REFRESH_TOKEN: z.string().optional(),
  GOOGLE_TOKEN_FILE: z.string().optional(),
  GMAIL_SYNC_QUOTA_BUDGET_PER_MINUTE: z.coerce.number().int().min(100).max(6000).default(2000),
  GMAIL_SYNC_MAXIMUM_BURST: z.coerce.number().int().min(20).max(2000).default(400),
  GMAIL_SYNC_CONCURRENCY: z.coerce.number().int().min(1).max(2).default(2),
  GMAIL_SYNC_MAX_BACKOFF_MS: z.coerce.number().int().min(1000).max(64000).default(64000),
  GMAIL_SYNC_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(8),
});
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env === process.env) dotenv({ quiet: true });
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Invalid server configuration.");
  const c = parsed.data;
  if (c.GMAIL_SYNC_MAXIMUM_BURST > c.GMAIL_SYNC_QUOTA_BUDGET_PER_MINUTE)
    throw new AppError(
      "VALIDATION_ERROR",
      "GMAIL_SYNC_MAXIMUM_BURST cannot exceed GMAIL_SYNC_QUOTA_BUDGET_PER_MINUTE.",
    );
  if (c.MAIL_PROVIDER === "gmail") {
    if (c.GOOGLE_TOKEN_FILE && !c.GOOGLE_REFRESH_TOKEN) {
      try {
        c.GOOGLE_REFRESH_TOKEN = readFileSync(c.GOOGLE_TOKEN_FILE, "utf8").trim();
      } catch {
        throw new AppError(
          "AUTHENTICATION_ERROR",
          "GOOGLE_TOKEN_FILE must point to a readable refresh-token file. Run pnpm auth:gmail or set GOOGLE_REFRESH_TOKEN.",
        );
      }
    }
    if (!c.GOOGLE_CLIENT_ID || !c.GOOGLE_CLIENT_SECRET)
      throw new AppError(
        "AUTHENTICATION_ERROR",
        "Gmail requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. Set them in .env.",
      );
    if (!c.GOOGLE_REFRESH_TOKEN)
      throw new AppError(
        "AUTHENTICATION_ERROR",
        "Gmail requires GOOGLE_REFRESH_TOKEN or GOOGLE_TOKEN_FILE. Run pnpm auth:gmail and set GOOGLE_TOKEN_FILE to the generated file.",
      );
  }
  return c;
}

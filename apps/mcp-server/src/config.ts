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
});
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env === process.env) dotenv({ quiet: true });
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new AppError("VALIDATION_ERROR");
  const c = parsed.data;
  if (c.MAIL_PROVIDER === "gmail") {
    if (c.GOOGLE_TOKEN_FILE && !c.GOOGLE_REFRESH_TOKEN) {
      try {
        c.GOOGLE_REFRESH_TOKEN = readFileSync(c.GOOGLE_TOKEN_FILE, "utf8").trim();
      } catch {
        throw new AppError("AUTHENTICATION_ERROR");
      }
    }
    if (!c.GOOGLE_CLIENT_ID || !c.GOOGLE_CLIENT_SECRET || !c.GOOGLE_REFRESH_TOKEN)
      throw new AppError("AUTHENTICATION_ERROR");
  }
  return c;
}

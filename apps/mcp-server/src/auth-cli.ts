import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { config } from "dotenv";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import { AppError, safeError } from "../../../packages/core/src/errors.js";
import { gmailScope } from "../../../packages/providers/src/gmail.js";

config({ quiet: true });
async function authorize() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  const redirect = new URL(
    process.env.GOOGLE_REDIRECT_URI ?? "http://127.0.0.1:4318/oauth/callback",
  );
  if (
    !clientId ||
    !secret ||
    redirect.protocol !== "http:" ||
    redirect.hostname !== "127.0.0.1" ||
    !redirect.port ||
    redirect.pathname !== "/oauth/callback"
  )
    throw new AppError("VALIDATION_ERROR");
  const auth = new OAuth2Client({
    clientId,
    clientSecret: secret,
    redirectUri: redirect.toString(),
    transporterOptions: { timeout: 15000, retry: false },
  });
  const state = randomBytes(32).toString("hex");
  const pkce = await auth.generateCodeVerifierAsync();
  const url = auth.generateAuthUrl({
    scope: [gmailScope],
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
  });
  await new Promise<void>((ok, fail) => {
    let consumed = false;
    const server = createServer(async (req, res) => {
      res.setHeader("Content-Type", "text/plain");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      try {
        if (req.method !== "GET" || req.headers.host !== redirect.host)
          throw new AppError("PERMISSION_DENIED");
        const incoming = new URL(req.url ?? "/", redirect);
        const given = Buffer.from(incoming.searchParams.get("state") ?? "");
        const expected = Buffer.from(state);
        if (
          incoming.pathname !== redirect.pathname ||
          consumed ||
          given.length !== expected.length ||
          !timingSafeEqual(given, expected)
        )
          throw new AppError("PERMISSION_DENIED");
        consumed = true;
        const code = incoming.searchParams.get("code");
        if (!code) throw new AppError("AUTHENTICATION_ERROR");
        const { tokens } = await auth.getToken({
          code,
          codeVerifier: pkce.codeVerifier,
          redirect_uri: redirect.toString(),
        });
        if (!tokens.refresh_token) throw new AppError("AUTHENTICATION_ERROR");
        mkdirSync("secrets", { recursive: true, mode: 0o700 });
        writeFileSync("secrets/google-refresh-token.local", tokens.refresh_token, { mode: 0o600 });
        res.end("Account authorized. Close this tab and return to the terminal.");
        clearTimeout(timer);
        server.close();
        ok();
      } catch (e) {
        res.statusCode = 400;
        res.end(safeError(e).message);
        if (consumed) {
          clearTimeout(timer);
          server.close();
          fail(new AppError("AUTHENTICATION_ERROR"));
        }
      }
    });
    const timer = setTimeout(() => {
      server.close();
      fail(new AppError("AUTHENTICATION_ERROR"));
    }, 180000);
    server.once("error", (e) => {
      clearTimeout(timer);
      fail(e);
    });
    server.listen(Number(redirect.port), "127.0.0.1", () => {
      process.stderr.write(`Open this Google consent URL in your browser:\n${url}\n`);
    });
  });
  process.stderr.write(
    "Refresh token saved privately to secrets/google-refresh-token.local. Set GOOGLE_TOKEN_FILE to this path. Restrict this file to your OS account.\n",
  );
}
authorize().catch((e) => {
  process.stderr.write(`${safeError(e).message}\n`);
  process.exitCode = 1;
});

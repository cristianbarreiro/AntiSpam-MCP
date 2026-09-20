import { randomBytes } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CleanupService } from "../../../packages/core/src/cleanup.js";
import { safeError } from "../../../packages/core/src/errors.js";
import { MailboxService } from "../../../packages/core/src/mailbox.js";
import { GmailProvider, gmailTransport } from "../../../packages/providers/src/gmail.js";
import { MockProvider } from "../../../packages/providers/src/mock.js";
import { SqliteStore } from "../../../packages/storage/src/sqlite.js";
import { loadConfig } from "./config.js";
import { createDashboardServer } from "./http.js";
import { createMcpServer } from "./mcp.js";

let startupStage = "configuration";

async function main() {
  const c = loadConfig();
  startupStage = "database_open";
  const store = new SqliteStore(resolve(c.DATABASE_PATH));
  startupStage = "database_maintenance";
  store.migrate();
  store.prune();
  startupStage = "provider_connection";
  const provider =
    c.MAIL_PROVIDER === "mock"
      ? new MockProvider()
      : new GmailProvider(
          gmailTransport(
            c.GOOGLE_CLIENT_ID ?? "",
            c.GOOGLE_CLIENT_SECRET ?? "",
            c.GOOGLE_REFRESH_TOKEN ?? "",
          ),
        );
  const account = await provider.getAccountInfo();
  const mailbox = new MailboxService(provider, store, account);
  const cleanup = new CleanupService(mailbox);
  const key = randomBytes(32).toString("hex");
  const server = createDashboardServer(mailbox, cleanup, key, resolve("apps/dashboard/dist"));
  startupStage = "dashboard_listen";
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(c.PORT, "127.0.0.1", () => ok());
  });
  startupStage = "ready";
  mkdirSync(".data", { recursive: true, mode: 0o700 });
  const keyPath = resolve(".data/dashboard-key.local");
  writeFileSync(keyPath, key, { mode: 0o600 });
  process.stderr.write(
    `${JSON.stringify({
      event: "server_started",
      provider: c.MAIL_PROVIDER,
      dashboard: `http://127.0.0.1:${c.PORT}`,
      loginKeyFile: ".data/dashboard-key.local",
    })}\n`,
  );
  const mcp = createMcpServer(mailbox, cleanup);
  if (!process.argv.includes("--dashboard")) await mcp.connect(new StdioServerTransport());
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    server.close();
    void mcp.close();
    try {
      unlinkSync(keyPath);
    } catch {
      /* Already removed. */
    }
    store.close();
    process.exit(0);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  if (!process.argv.includes("--dashboard")) process.stdin.once("end", close);
}
main().catch((e) => {
  const systemCode =
    typeof e === "object" && e !== null && "code" in e && typeof e.code === "string"
      ? e.code
      : undefined;
  process.stderr.write(
    `${JSON.stringify({
      event: "startup_failed",
      stage: startupStage,
      ...safeError(e),
      ...(systemCode ? { systemCode } : {}),
    })}\n`,
  );
  process.exit(1);
});

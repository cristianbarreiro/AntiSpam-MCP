import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CleanupService } from "../../../packages/core/src/cleanup.js";
import { safeError } from "../../../packages/core/src/errors.js";
import type { MailboxService } from "../../../packages/core/src/mailbox.js";
import { descriptions, schemas, type ToolName, toolsFor } from "./contracts.js";
export function createMcpServer(mailbox: MailboxService, cleanup: CleanupService) {
  const server = new McpServer({ name: "inboxguardian", version: "0.1.0" });
  const call = toolsFor(mailbox, cleanup);
  for (const name of Object.keys(schemas) as ToolName[]) {
    const d = descriptions[name];
    server.registerTool(
      name,
      {
        description: d.text,
        inputSchema: schemas[name],
        annotations: {
          readOnlyHint:
            d.kind === "READ" && !["mailbox_scan", "sender_cleanup_preview"].includes(name),
          destructiveHint: d.kind === "SENSITIVE",
          openWorldHint: true,
        },
      },
      async (args: unknown) => {
        try {
          const result = await call(name, args);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        } catch (e) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: JSON.stringify(safeError(e)) }],
          };
        }
      },
    );
  }
  return server;
}

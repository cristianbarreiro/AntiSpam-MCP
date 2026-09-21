# MCP contracts

Status: canonical; official TypeScript SDK v1, stdio transport.

Every tool uses strict Zod input validation and sanitized application errors.
Handlers call application services. There is no Gmail API code or human-approval
issuer in MCP handlers. One process/account is the authenticated stdio principal.
Use the shared dispatcher in apps/mcp-server/src/contracts.ts for dashboard parity.

| Tool | Class | Effects / bounds |
| --- | --- | --- |
| mailbox_scan | READ | 1–10000 metadata messages, default 1000; versioned dashboard snapshot, five-minute active cache and durable scan audit |
| sender_list | READ | Filter/sort cached summaries; limit <=100, bounded offset, five-minute freshness |
| sender_messages | READ | On-demand metadata page <=100; opaque sender-bound five-minute cursor |
| sender_message_classifications | READ | Same bounded page plus deterministic category/protections |
| mailbox_noise_report | READ | Observable 7/30/90-day metrics and explicit scan coverage |
| sender_set_detection | WRITE | Persist DETECT/IGNORE preference and audit |
| sender_cleanup_preview | READ | Mailbox non-mutating; persist frozen preview of <=1000 messages or fail if incomplete |
| cleanup_plan_preview | READ | Persist one typed plan for <=20 senders and <=1000 exact IDs |
| sender_cleanup_execute | SENSITIVE | Require preview UUID + approved token; exact IDs to Trash; per-message outcomes |
| cleanup_plan_execute | SENSITIVE | Same approval boundary with per-sender outcome summaries |
| sender_cleanup_cancel | WRITE | Invalidate approval / stop remaining work; no rollback |
| audit_list | READ | At most 100 account-scoped local audit records |

READ means mailbox read-only; scan/preview descriptions disclose local writes and
SDK readOnlyHint is false for those tools, including cleanup_plan_preview. Descriptions are part of the security
boundary but never replace enforcement. All mailbox text remains untrusted data.
No confirmation tool exists. The user approves in the local dashboard and either
executes there or explicitly transfers the token to the MCP client.

Error codes and safe messages are in core/errors.ts. No raw stack/provider errors.
Pagination tokens and schemas are implementation-owned; preserve public contracts
with official SDK client tests. Current SDK reference:
https://ts.sdk.modelcontextprotocol.io/server

# Architecture

Status: canonical; implemented local single-user foundation.

## Source navigation

| Location | Responsibility |
| --- | --- |
| packages/core/src/domain.ts, store.ts | Provider-independent entities and ports |
| packages/core/src/sender.ts, aggregation.ts, classification.ts | Pure normalization, per-message/group statistics and deterministic rules |
| packages/core/src/mailbox.ts | Bounded scanning, deduplicated dashboard jobs, progress, snapshots, policies and sender paging |
| packages/core/src/cleanup.ts | Granular/multi-sender preview, approval, execution, cancellation and reconciliation |
| packages/providers/src/mock.ts | Synthetic in-memory mailbox |
| packages/providers/src/gmail.ts | OAuth token boundary, Gmail REST, DTO mapping, full/history pages and retry policy |
| packages/providers/src/gmail-quota.ts | Quota-unit token bucket, concurrency gate, cooldown and diagnostics |
| packages/storage/src/sqlite.ts | SQLite adapter, versioned migration, atomic approval claim, outcomes and audit |
| apps/mcp-server/src/contracts.ts, mcp.ts | Shared validated operations and official SDK stdio adapter |
| apps/mcp-server/src/http.ts | Loopback dashboard snapshot/progress API and separate human approval boundary |
| apps/mcp-server/src/config.ts, index.ts, auth-cli.ts | Composition, environment validation and interactive OAuth helper |
| apps/dashboard | React UI over application HTTP contracts; no Gmail imports |
| tests | Domain, service, persistence, provider, HTTP and official MCP contracts |

## Dependency and trust flow

AI client → MCP adapter → application services → domain/provider/storage ports.
Provider and SQLite adapters depend inward. Core imports neither Gmail, React,
MCP transport nor SQLite. All packages use shared root tooling and strict TypeScript.
The browser uses the same validated application operations through HTTP, not a
second implementation of Gmail or business logic.

Gmail dashboard synchronization flows page-by-page through the quota scheduler into
account-scoped SQLite message rows and an atomic checkpoint. The dashboard consumes
versioned local snapshots. A completed full reconciliation records `historyId`; later
refreshes apply Gmail history changes and fall back to a paced full reconciliation on
an expired history ID. In-process single flight plus a SQLite lease permits one worker
per account.

Dashboard initialization is one account-and-scope-bound job. A cold launch publishes
the view only after scan, grouping, classification, reports and persistence agree on
one dataset version. A warm launch restores the last valid SQLite snapshot and keeps
local filtering and detail expansion usable while a bounded refresh runs. MCP tool
contracts remain independent and backwards compatible.

Human dashboard → isolated confirmation capability → persisted approval.
MCP has execution but no approval-creation operation. SECURITY owns this boundary.
Mailbox content is data throughout; classification never grants authority.

Gmail mapping turns labels/headers into generic signals. Outlook can implement
MailProvider without changing aggregation, cleanup, MCP tools or UI.

Single process per workspace/provider account; default port binding enforces the
normal launch path. Do not run dashboard-only and stdio instances simultaneously.
Hosted/multi-user operation, background workers and LLM classification are out of scope.

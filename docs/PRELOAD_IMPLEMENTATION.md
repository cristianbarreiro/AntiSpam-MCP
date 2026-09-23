# Dashboard preload implementation report

## 1. Root causes

Verified root causes and the pre-change evidence are recorded in
[PRELOAD_AUDIT.md](PRELOAD_AUDIT.md). The blocking behavior came from a three-request
initial view, one global loading boolean, an expiring memory-only dataset, repeated
provider reads for sender expansion and no retained job status. Filter requests did
not rescan Gmail, but the global busy state made them appear as another blocking load.

No live Gmail latency or quota measurement was performed. Any Gmail performance gain
is therefore supported by request/concurrency behavior, not an invented wall-clock
benchmark.

## 2. Implementation summary

- Added an account-and-scope-bound initialization job with deduplication and explicit
  stages from connection through ready/error.
- Retrieval stays indeterminate while Gmail's exact bounded total is unknown. Once
  retrieval finishes, the displayed 58/72/86/94 stage weights represent completion of
  retrieval, grouping, classification/view construction and durable publication; 100
  is emitted only after the saved snapshot is consumable.
- Added a versioned aggregate snapshot containing scan summary, all sender groups,
  7/30/90-day reports and the bounded message metadata required by initial details.
- Added schema v2 storage for the latest snapshot and schema v3 resumable Gmail
  message/checkpoint storage with atomic page commits.
- Added authenticated local endpoints to start/read job status and retrieve the
  coherent snapshot plus pending operations.
- Replaced the dashboard's blocking scan sequence with cold-load progress, warm-cache
  hydration and nonblocking background refresh.
- Filters, sender pagination and detail expansion now use the prepared browser dataset;
  they do not request another Gmail scan.
- Gmail metadata retrieval remains metadata-only. Every request now crosses a
  quota-unit token bucket with a 2,000-unit/minute budget, burst 400 and concurrency
  2. Rate-limit and retryable provider responses trigger a shared exponential
  cooldown with jitter; Trash mutations are still never retried automatically.

## 3. Changed files

- `packages/core/src/domain.ts`: snapshot and job status contracts.
- `packages/core/src/store.ts`: snapshot persistence port.
- `packages/core/src/mailbox.ts`: job lifecycle, deduplication, progress, restore and
  aggregate snapshot preparation.
- `packages/storage/src/sqlite.ts`: schema v2 snapshots plus schema v3 message,
  checkpoint and account-lease tables.
- `packages/providers/src/gmail.ts`, `gmail-quota.ts`: quota-aware full and incremental
  metadata synchronization.
- `apps/mcp-server/src/http.ts`: private dashboard initialization/status/snapshot API.
- `apps/dashboard/src/main.tsx`, `style.css`: loading surface, hydration, local filters,
  local details and background-refresh state.
- `tests/foundation.test.ts`, `tests/gmail-http.test.ts`: cold/warm initialization,
  deduplication, HTTP aggregation and Gmail concurrency coverage.
- README and canonical context: architecture, decision and data-lifecycle updates.

## 4. Behavior walkthrough

- **Empty cache:** login starts one job. The loading surface shows its real stage,
  processed count and determinate percentage only after the bounded total is known.
  The dashboard appears after the snapshot and required controls are ready.
- **Warm cache:** login restores the last valid account/scope snapshot immediately.
  A refresh then runs without blocking local filters or details.
- **Refresh:** the previous valid dataset remains visible. Success atomically replaces
  it; recoverable failure keeps the prior view and exposes an error/retry state.
- **Filtering:** apply, sort and pagination operate synchronously over prepared groups.
  Expanding a sender reads already prepared message metadata.
- **Error/retry:** jobs end in ready or error. The last status is retained for polling,
  and the loading view offers retry rather than leaving “Procesando…” indefinitely.

## 5. Security and compatibility

OAuth scopes, Gmail query fields, MCP tool names/schemas, frozen cleanup previews,
human confirmation, single-use approval and Trash-only mutation remain unchanged.
Schema v2 snapshots and schema v3 sync rows migrate older databases in place. Data is
account-scoped and contains no bodies, attachments, OAuth tokens or credentials. It
does contain locally sensitive displayed metadata such as subjects and Gmail page
tokens, so the existing requirement to protect `.data/` still applies.

## 6. Tests and performance comparison

- The suite includes quota, restart, upsert, incremental history and lease coverage.
- Automated evidence shows simultaneous initialization uses one provider page for the
  90-message synthetic mailbox; a warm restart uses zero provider pages before the
  dashboard is usable.
- A real local cold start reached `ready`, `source: live`, 100%, with 90 messages, six
  senders and 90 preloaded details. Restarting against the same temporary database
  returned `ready`, `source: cache` immediately with the same dataset.
- Sender expansion previously caused another provider page and metadata reads. It now
  uses the snapshot and causes zero provider calls.
- Gmail metadata requests were sequential (peak concurrency 1). The tested bound is
  now no more than 2, with quota-unit pacing, automatic cooldown and persisted resume.
- A pre-change wall-clock probe failed in the restricted TypeScript loader, so this
  report does not claim a timing improvement. Final lint, typecheck, build and visual
  validation passed. The visual check covered the indeterminate retrieval state, the
  ready summary/table and expansion of 25 locally preloaded sender messages.

## 7. Remaining limitations

- Live Gmail OAuth/API behavior still requires the documented manual smoke test with an
  explicitly authorized test account.
- The first synchronization is a bounded full scan; later refreshes use Gmail History
  and fall back to full reconciliation when that history ID expires.
- Progress during Gmail retrieval is indeterminate until a page completes because an
  honest exact total is unavailable for a bounded sample.
- The dashboard requests and keeps at most 10,000 recent messages in its local
  snapshot. Broader deep history remains outside the selected product scope.

# Dashboard preload audit

Status: verified against the implementation before the preload optimization.

## Root causes

1. The dashboard has no initialization contract. After `mailbox_scan` returns, the
   browser must make separate `sender_list` and `mailbox_noise_report` requests before
   cards and filters become usable (`apps/dashboard/src/main.tsx`). The scan result by
   itself therefore does not mean that the initial view is ready.
2. Loading is represented by one `busy` boolean. It cannot distinguish provider
   connection, metadata retrieval, classification, view preparation, refresh, error or
   completion. Every operation can consequently replace its label with
   “Procesando…” even when unrelated controls are already usable.
3. The scanned dataset is held only in `MailboxService.cache`, expires after five
   minutes and disappears on restart (`packages/core/src/mailbox.ts`). SQLite stores
   policies, approvals, outcomes and audit events, but no consistent dashboard
   snapshot (`packages/storage/src/sqlite.ts`). A warm launch must scan again.
4. Expanding a sender calls `sender_message_classifications`, which invokes the mail
   provider even when the same messages were already collected for the scan. With the
   mock provider this is one additional provider page per first expansion; with Gmail
   it also repeats metadata requests for every returned message.
5. Filters use the already scanned in-memory cache on the server, so they do not start
   a full Gmail scan. The UI nevertheless routes them through the global `busy` state,
   disables unrelated controls and provides no protection against stale responses.
6. Concurrent scan requests are not deduplicated and there is no retained terminal
   job status. A client that disconnects or misses completion has no status endpoint
   from which to recover.

## Baseline and constraints

- The synthetic mailbox contains 90 messages across six senders. The initial scan is
  bounded and metadata-only, but the browser needs three HTTP operations before it has
  the summary, sender rows and 30-day report.
- The Gmail adapter lists at most 100 IDs per page and then fetches metadata
  sequentially for each ID. Read retries are bounded; Trash mutations are never
  retried. This safety behavior must remain unchanged.
- A direct timing probe could not be recorded in the restricted runner because the
  TypeScript loader failed while resolving the local OS user. No timing number is
  inferred from that failed probe. Automated tests will measure observable call counts
  and readiness instead.
- No real Gmail account, OAuth credential or mailbox mutation is used in this work.

## Smallest coherent change

Add one account-and-scope-bound initialization job with retained status, a versioned
SQLite snapshot containing only the metadata already allowed by the product, and one
aggregate dashboard snapshot endpoint. A cold launch waits for a complete snapshot; a
warm launch hydrates the last valid snapshot and refreshes it without blocking local
filters or sender details. MCP tool names and cleanup authorization remain unchanged.

# Gmail safe sync and quota-aware architecture

## Audit and root cause

The Gmail adapter used `messages.list` pages of at most 100 IDs and fetched one
metadata record per ID. Reads were metadata-only and a dashboard job already had an
in-process single-flight guard, but the previous concurrency/backoff control counted
requests rather than Gmail quota units. With the May 2026 quota model,
`messages.get` costs 20 units, so 300 fast reads can consume the 6,000-unit
per-user/per-project minute limit. The previous snapshot was published only after the
whole bounded scan, so a process restart or terminal retry discarded that run's
progress. No `history.list` path existed.

There is no hard-coded 300-message cap. The relevant product bounds were 100 IDs per
Gmail page, 1,000 messages requested by the dashboard, and 10,000 accepted by the
core scan contract. Gmail reads used `Promise.all` in bounded batches; Trash mutations
were individual and never retried. The dashboard starts one job through
`/api/dashboard/start`, polls `/api/dashboard/status`, and reads local snapshots from
`/api/dashboard/snapshot`.

## Implemented flow

Every Gmail request now passes through one per-provider token bucket. Costs are
centralized in `GMAIL_QUOTA_COST`: profile 1, `messages.list` 5, `messages.get` 20,
`history.list` 2, and `messages.trash` 20. Defaults are 2,000 units/minute, a
400-unit maximum burst, and at most two active requests. The bucket waits before a
request instead of relying on 403/429 responses.

Full synchronization processes one 100-ID page at a time. Each page's metadata and
checkpoint are committed atomically to SQLite. Message ID is the account-scoped
primary key, so repeated pages and resumed work are idempotent. A generation marks
messages observed by a full reconciliation; stale rows are removed only after that
reconciliation completes.

The checkpoint contains mode, status, next page token, processed count, estimated
total, last processed ID, generation, stable history ID, incremental history start ID,
successful-sync timestamp, last error and retry time. It survives Node, dashboard and Windows restarts. If a
stored page token is rejected, a safe full listing restarts with a new generation;
existing local rows remain usable and repeated IDs are upserted.

After a completed full sync, the current profile `historyId` is stored. Later forced
refreshes call `history.list` and fetch metadata only for added or label-changed IDs;
deleted IDs are removed locally. An expired `historyId` (HTTP 404) starts a paced full
reconciliation. No Gmail polling loop or Pub/Sub dependency was added.

The service retains the existing in-memory single flight and adds an account-scoped
SQLite lease so tabs or another local server process cannot create a second worker.
The dashboard reads SQLite snapshots. Starting at 200 indexed messages it can show a
partial local view while synchronization continues; snapshots refresh periodically
and at completion.

## Recovery and user experience

403 rate-limit reasons, HTTP 429 and retryable 5xx reads use truncated exponential
backoff starting at one second, fresh jitter up to one second, a 64-second ceiling,
and at most eight retries by default. A valid `Retry-After` takes precedence. The
shared scheduler stops new Gmail requests during cooldown. Authentication and
permission failures do not enter this retry loop, and uncertain Trash mutations are
still never retried.

During pacing or provider cooldown, SQLite remains readable and the dashboard reports
that Gmail requested a lower speed, shows retained progress and resumes automatically.
Only exhausted recovery becomes a terminal error with a manual retry.

Structured events include quota waits, rate limits, retry scheduling and page
completion. They contain counts, quota diagnostics, timing, concurrency and sync mode;
they do not contain tokens, message bodies, subjects or addresses.

## Configuration

| Variable | Default | Constraint |
| --- | ---: | --- |
| `GMAIL_SYNC_QUOTA_BUDGET_PER_MINUTE` | 2000 | 100–6000 |
| `GMAIL_SYNC_MAXIMUM_BURST` | 400 | 20–2000 and no more than budget |
| `GMAIL_SYNC_CONCURRENCY` | 2 | 1–2 |
| `GMAIL_SYNC_MAX_BACKOFF_MS` | 64000 | 1000–64000 |
| `GMAIL_SYNC_MAX_RETRIES` | 8 | 0–10 |

The dashboard requests up to 10,000 recent messages. Larger mailboxes remain a bounded
product scope and continue from the stored page token on a later refresh.

## Verification and remaining work

Automated tests cover 1,000 quota-priced metadata operations, concurrency, both Gmail
403 rate-limit reasons, bounded rate and provider retries, jitter, Retry-After,
authentication without retry, checkpoint/restart, duplicate upsert, incremental
history, expired-history reconciliation, cooldown state, cross-service lease,
metadata-only parsing, dashboard preload and the mock provider.

Live OAuth and Gmail quota behavior still require the manual smoke test with an
explicitly authorized test account. Gmail push notifications are intentionally left
for future work. Mailboxes above 10,000 indexed messages need a future background
continuation policy beyond the current product cap.

Official references:

- <https://developers.google.com/workspace/gmail/api/reference/quota>
- <https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list>
- <https://developers.google.com/workspace/gmail/api/guides/handle-errors>

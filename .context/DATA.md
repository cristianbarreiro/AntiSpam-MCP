# Data lifecycle

Status: canonical implemented persistence; schema version 1.

| Data | Ownership/lifecycle |
| --- | --- |
| Sender policies | Application-owned persistent per-account user choices until explicit disposal |
| Message metadata / groups / scan state | Provider-owned or derived, memory only; cache five minutes, max 10000 messages |
| Pagination mappings | Memory only, five-minute expiry, at most 500 entries per layer |
| Cleanup previews | Exact IDs plus minimal sender/category/protection breakdown, action and expiry |
| Confirmation | Hash only, bound to preview row; short-lived and atomically consumed |
| Outcomes | Durable per-message intent/result for recovery, no automatic resume |
| Audit events | Append-oriented application records without subjects/bodies/credentials |
| OAuth credentials | Private environment or ignored owner-protected file; access tokens in memory |
| Bodies/attachments | Provider-owned; never downloaded by normal scan or persisted |

SqliteStore implements the core Store port. Versioned migrations use PRAGMA
user_version inside BEGIN IMMEDIATE; repeat migration is a no-op, future schema
versions fail closed. Startup applies pending controlled migrations; db:migrate
provides explicit setup. Tests use the same migration against disposable databases.
WAL, foreign keys and FULL synchronous writes protect atomic approval/audit state.
P0 adds fields inside the existing preview JSON, so schema v1 remains compatible and
existing policy/audit rows are untouched. No heavy ORM or mailbox mirror.

Startup pruning removes completed/expired non-running preview records and audit
records older than 30 days. Uncertain/in-progress operations and their audit records
are retained for manual reconciliation; do not delete them to suppress a failure.
Cache expiry is enforced on access; memory is released on process exit. Sender
policies persist until the owner deliberately disposes of local application state.
Stop the server before deliberate account-data disposal or backup. Database copies
and local secret files remain sensitive; SQLite is not encrypted in Phase 1.

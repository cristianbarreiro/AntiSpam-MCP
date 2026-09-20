# Testing expectations

Status: canonical; Vitest tests in tests/.

Run pnpm typecheck, pnpm lint, pnpm test and pnpm build before completion of broad
changes. Focused development checks can target affected tests. Report actual results,
not inferred coverage. README owns setup commands and manual Gmail prerequisites.

| Boundary | Evidence to maintain |
| --- | --- |
| Domain | Sender parsing/isolation, deduplication, dates, read counts, deterministic reasons |
| Classification | Spam/promotions, important protection, user override, no-reply not sufficient |
| Mixed/granular P0 | Per-message breakdown, default protections, typed criteria, two-sender frozen plan |
| Policies | Persistence, ignored candidates absent, restoration works |
| Providers | Metadata-only mapping, opaque paging, errors, account scope, Trash-only effects |
| Cleanup | Non-mutating preview, missing/forged/expired/replayed approval denied, frozen IDs |
| Recovery | Atomic concurrent claim, cancellation, partial/uncertain provider outcomes, storage failure |
| Trust | Email text cannot authorize mutation; no MCP approval issuer; local auth/origin checks |
| MCP | Official SDK client over paired transport, validated public schemas and vertical slice |
| UI | Scan/filter/expand/toggle/preview/cancel/confirm/result in mock mode |

Use synthetic mail and fake transports; routine checks need no real account. Tests
use the production migration on memory/disposable SQLite. Live integration requires
an explicitly authorized test account and cannot be claimed from mock success. Follow
[the Gmail smoke test](../docs/GMAIL_SMOKE_TEST.md) and record evidence without private data.
Doc changes need link/ownership/OKF checks, not another application harness. Broaden
tests when failures, cross-module impact or security risk justify it.

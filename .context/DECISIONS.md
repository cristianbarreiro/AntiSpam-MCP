# Decisions

Status: canonical decision status and rationale; detailed requirements have separate owners.

## D001 — Provider independence
Status: accepted. Gmail first, mock for development; Outlook can implement the same
MailProvider port. ARCHITECTURE owns component boundaries.

## D002 — Human-controlled Trash
Status: accepted. Frozen preview IDs prevent scope expansion. Ten-minute previews,
two-minute single-use approvals, atomic claims, no permanent delete or automatic
retries. SECURITY owns enforcement and uncertainty handling.

## D003 — Metadata-first privacy
Status: accepted. Metadata is ephemeral; only policies, approval scope and audit/state
are durable. DATA owns lifecycle; no LLM or body retrieval in Phase 1.

## D004 — Stack
Status: accepted for Phase 1. Node 24 LTS, TypeScript, pnpm workspace, official MCP
SDK v1, Zod, SQLite through node:sqlite, React, Vite, Vitest, Biome and dotenv.
Root tooling/dependencies avoid duplicate package setups; lockfile pins resolved
versions. Node's SQLite API is experimental in Node 24; it is isolated behind Store.
No native addon/ORM is needed; review driver maturity before production distribution.

## D005 — Compact context
Status: accepted. AGENTS routes to subject owners and five workflows. DOMAIN includes
glossary. One local YAML OKF retrieval index; no external conformance claim.

## D006 — Local human approval boundary
Status: accepted. Single local user/account, MCP stdio, loopback HTTP dashboard.
Dashboard private key is generated per process, stored outside source control and
never exposed by MCP. OS/file/browser owner is trusted. SECURITY defines limitations.

## D007 — Recovery and bounded work
Status: accepted. Max 100 pages per collection; preview rejects incomplete scope.
Durable per-message intent before provider calls. Read-only reconciliation never
retries mutation; overlapping uncertain operations block cleanup. Manual recovery
is required if provider state cannot resolve uncertainty.

## D008 — Differential P0 selection
Status: accepted. Per-message classification augments the compatible group enum;
MIXED is presentation-only. A single JSON-backed preview freezes granular selections
across at most 20 senders and 1000 IDs. Protected inclusion needs a separate local
confirmation. Gmail mutations remain per-message because batch success has no
individual result detail; bounded backoff applies only to idempotent reads.

## D009 — Versioned dashboard snapshot and authoritative preload
Status: accepted. One initialization job per account/scope prepares a consistent
metadata-only dashboard snapshot and exposes truthful retained progress. SQLite keeps
the latest bounded snapshot for warm startup and 30-day pruning; refresh publishes a
new dataset version only after all required derived data is ready. Filters, pagination
and scanned sender details use the prepared local dataset. Gmail metadata reads use
bounded concurrency while mutation behavior remains unchanged.

## Meaningful follow-up
Live Gmail OAuth/API verification; P1 policies and future-rule consent; richer
sender/RFC normalization; actionable manual resolution of uncertain operations;
encrypted/OS secret storage; user-facing account disposal; broader mailboxes beyond
the preview cap; production readiness of SQLite runtime; automated browser regression;
Outlook adapter.
Remote hosting/multi-user auth requires a new security design, not a config switch.

## D010 — Quota-aware resumable Gmail synchronization
Status: accepted. All Gmail calls traverse a quota-unit token bucket with conservative
defaults of 2,000 units/minute, burst 400 and concurrency 2. Full pages are upserted
with atomic SQLite checkpoints and an account lease. Completed full sync stores
`historyId`; refresh uses `history.list`, with paced full reconciliation after 404.
Rate limits cool down and resume automatically; authentication fails immediately and
Trash mutations remain non-retried.

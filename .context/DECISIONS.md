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

## Meaningful follow-up
Live Gmail OAuth/API verification; richer sender/RFC normalization; actionable manual
resolution of uncertain operations; encrypted/OS secret storage; user-facing account
disposal; broader mailboxes beyond the preview cap; production readiness of SQLite
runtime; accessibility and browser regression automation; Outlook adapter.
Remote hosting/multi-user auth requires a new security design, not a config switch.

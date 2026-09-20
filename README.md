# Inbox AntiSpam MCP

Inbox AntiSpam MCP analyzes mailbox metadata, groups messages by sender, explains
deterministic classifications, and lets the mailbox owner review cleanup before
moving an exact approved set of messages to Trash.

**Status:** Phase 1 local foundation. The complete workflow runs with synthetic
mail. Gmail is implemented behind the same provider interface, but requires OAuth
credentials and has not been exercised against a real account in this repository.

## Safety model

- Mail subjects, sender names, headers, and all provider content are untrusted data.
- Classification never authorizes mailbox mutation.
- A cleanup preview freezes the exact message IDs and expires after ten minutes.
- Human approval is issued only by the private local dashboard, expires after at
  most two minutes, and can execute once.
- Cleanup moves messages to Trash. Permanent deletion is not implemented.
- Per-message intent and outcomes are persisted before and after provider calls.
  Uncertain outcomes are inspected without automatically retrying the mutation.

See [.context/SECURITY.md](.context/SECURITY.md) for the complete boundary.

## Requirements

- Node.js 24 LTS (`>=24.16.0 <25`)
- pnpm 11.19 or compatible

## Mock-provider quick start

```powershell
pnpm install
Copy-Item .env.example .env
pnpm db:migrate
pnpm dev
```

The server prints the dashboard URL and writes a temporary login key to
`.data/dashboard-key.local`. Open `http://127.0.0.1:4317`, paste that key, and scan
the synthetic mailbox. `pnpm dev` runs the dashboard only. Use `pnpm dev:mcp` when
an MCP client launches the stdio server; it also serves the dashboard on port 4317.

The mock mailbox is rebuilt when the process starts. Sender detection policies,
previews, audit records, and cleanup outcomes persist in SQLite unless a different
`DATABASE_PATH` is configured.

## Gmail configuration

Create a Google OAuth **Desktop app** and enable Gmail API. InboxGuardian requests
`https://www.googleapis.com/auth/gmail.modify`, because Gmail provides no narrower
scope that supports both metadata reads and moving messages to Trash. The adapter
does not expose sending or permanent deletion.

1. Copy `.env.example` to `.env` and set `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`, and the documented loopback `GOOGLE_REDIRECT_URI`.
2. Run `pnpm auth:gmail`, open the printed Google consent URL, and finish consent.
3. Set `GOOGLE_TOKEN_FILE=secrets/google-refresh-token.local` and
   `MAIL_PROVIDER=gmail` in `.env`.
4. Run `pnpm dev` or configure the MCP client to run `pnpm dev:mcp`.

The refresh-token file is ignored by Git. Protect `.data/` and `secrets/` with your
operating-system account permissions. Gmail OAuth/API behavior still requires
manual verification with an explicitly authorized test account.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Build and serve the local dashboard with the selected provider |
| `pnpm dev:mcp` | Start MCP over stdio and the local approval dashboard |
| `pnpm db:migrate` | Apply controlled SQLite migrations |
| `pnpm auth:gmail` | Run the interactive loopback OAuth helper |
| `pnpm test` | Run unit, integration, security, HTTP, and MCP contract tests |
| `pnpm lint` | Check formatting and static rules |
| `pnpm typecheck` | Run strict TypeScript checks |
| `pnpm build` | Compile the server/packages and build the React dashboard |

## MCP tools

| Tool | Class | Purpose |
| --- | --- | --- |
| `mailbox_scan` | READ | Read bounded metadata, cache summaries, and audit the scan |
| `sender_list` | READ | Filter and page compact sender statistics |
| `sender_messages` | READ | Fetch one bounded metadata page for a sender |
| `sender_set_detection` | WRITE | Persist the owner's DETECT/IGNORE preference |
| `sender_cleanup_preview` | READ | Persist a non-mutating frozen preview |
| `sender_cleanup_execute` | SENSITIVE | Move only a human-approved preview to Trash |
| `sender_cleanup_cancel` | WRITE | Invalidate approval or stop remaining work |
| `audit_list` | READ | Read bounded local security-relevant audit events |

MCP intentionally has no operation that creates a human confirmation. The owner
approves in the local dashboard and either executes there or deliberately gives the
short-lived token to the MCP client.

## Architecture

```text
MCP / local dashboard
        ↓
application services and provider-independent domain
        ↓                         ↓
MailProvider port              Store port
   ↓              ↓                ↓
mock           Gmail REST        SQLite
```

- `packages/core`: domain types, aggregation, rules, policies, cleanup orchestration
- `packages/providers`: synthetic and Gmail adapters
- `packages/storage`: versioned SQLite adapter
- `apps/mcp-server`: configuration, stdio MCP, dashboard API, OAuth helper
- `apps/dashboard`: small React workflow UI
- `tests`: synthetic vertical slice and boundary tests

Agents start at [AGENTS.md](AGENTS.md). Stable architecture and limits live in
[.context/](.context/INDEX.md) rather than being duplicated here.

## Current limits

- One local user and one provider account per process.
- A scan reads at most 10,000 messages; cleanup preview requires a complete sender
  selection of at most 1,000 messages.
- Sender parsing covers common display-name/address forms, not every RFC edge case.
- No body analysis, LLM classification, permanent delete, hosted authentication,
  encrypted SQLite, background worker, or Outlook adapter.
- Uncertain provider outcomes require manual inspection; reconciliation never retries
  a mailbox mutation.

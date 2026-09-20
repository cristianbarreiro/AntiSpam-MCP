---
name: mcp-tool-design
description: Design or change MCP operation contracts and route security-sensitive side effects consistently.
---
# Mcp Tool Design

## Use when
Adding/changing MCP tools or protocol-facing behavior.

## Do not use when
Internal changes without contract impact.

## Required context
Read repository-root paths: .context/MCP.md and .context/DOMAIN.md; SECURITY.md for mail/auth/mutation. Start from [AGENTS.md](../../AGENTS.md).

## Workflow
Inspect existing contracts/tests. Specify account scope, bounds, schemas, effects, errors, retries and cancellation. Route sensitive work through destructive-action-safety. Verify official SDK documentation for version changes. Implement through services, not Gmail code in handlers.

## Invariants
Canonical owners define requirements. Preserve authorized task scope and unrelated
work. This workflow grants no real mailbox permission and does not duplicate policy.

## Validation
Official client contract tests, invalid inputs, output bounds, safe errors and required authorization.

## Expected output
Reviewable contract/change, effects, checks and open choices.

---
name: repository-audit
description: Inventory context and implementation before broad changes or resolve conflicting repository instructions.
---
# Repository Audit

## Use when
Broad changes, onboarding or conflicting context.

## Do not use when
A routine edit with known affected owners.

## Required context
Read repository-root paths: AGENTS.md and .context/INDEX.md. Start from [AGENTS.md](../../AGENTS.md).

## Workflow
Verify root and working tree. Inventory hidden instructions, source, package/MCP/config files and tests, excluding dependency/build content. Inspect useful existing context before changes; never read credential values for an inventory. Map owners and identify conflicts, missing links and obsolete claims. Preserve unrelated work.

## Invariants
Canonical owners define requirements. Preserve authorized task scope and unrelated
work. This workflow grants no real mailbox permission and does not duplicate policy.

## Validation
Trace entrypoint to owner, workflow and source. Exercise INDEX scenarios when routing changes.

## Expected output
Compact findings, changes, exclusions and unresolved gaps.

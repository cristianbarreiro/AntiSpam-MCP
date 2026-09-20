---
name: destructive-action-safety
description: Review or change trash, bulk mutation, confirmation, OAuth permissions or account mutation safeguards.
---
# Destructive Action Safety

## Use when
Any cleanup/approval/permission path, including small refactors.

## Do not use when
Unrelated changes with no auth or mutation impact.

## Required context
Read repository-root paths: .context/SECURITY.md, .context/ARCHITECTURE.md and .context/TESTING.md; DATA/MCP when affected. Start from [AGENTS.md](../../AGENTS.md).

## Workflow
Trace client to authorization, atomic claim, per-message intent, adapter and audit. Check frozen scope, account binding, expiry/replay, cancellation, uncertainty and overlapping operations. Prepare code and synthetic tests. Real mailbox operations require the concrete preview and explicit valid user confirmation; code edits do not require redundant approval. Do not substitute model intent for unavailable human approval.

## Invariants
Canonical owners define requirements. Preserve authorized task scope and unrelated
work. This workflow grants no real mailbox permission and does not duplicate policy.

## Validation
Negative and positive tests for affected safety invariants, including storage/provider failures and no autonomous retries.

## Expected output
Affected boundary, concrete change, test evidence and remaining execution blockers.

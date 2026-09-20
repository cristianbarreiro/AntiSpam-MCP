---
name: documentation-maintenance
description: Maintain canonical knowledge, README and retrieval routes without duplicating policies.
---
# Documentation Maintenance

## Use when
Stable context, adapters, decisions, README, skills or routing edits.

## Do not use when
Code-only change with no knowledge/navigation impact.

## Required context
Read repository-root paths: .context/INDEX.md and the changed concept owner; DEVELOPMENT for freshness. Start from [AGENTS.md](../../AGENTS.md).

## Workflow
Identify requirement, rationale, explanation or workflow. Update one owner and link consumers. Keep README/adapters concise. Update decision status only when decided. Update OKF only for routing changes; it is not a separate policy or external standard. Avoid timestamp churn, duplicate glossary and empty files.

## Invariants
Canonical owners define requirements. Preserve authorized task scope and unrelated
work. This workflow grants no real mailbox permission and does not duplicate policy.

## Validation
Check changed links, skill frontmatter, OKF references, implementation status and affected INDEX scenarios.

## Expected output
Updated owner/references, reason and unresolved discrepancy.

---
name: testing
description: Select and run focused validation for implementation behavior, contracts, providers and regressions.
---
# Testing

## Use when
Behavior validation or test strategy.

## Do not use when
Editorial changes needing only link checks.

## Required context
Read repository-root paths: .context/TESTING.md and affected canonical owner/tests; SECURITY for security boundaries. Start from [AGENTS.md](../../AGENTS.md).

## Workflow
Discover actual scripts. Map behavior to observable cases. Use synthetic fixtures and fake providers; add meaningful regression tests. Run focused checks and repository-required validation. Broaden for failures or cross-module impact. Distinguish environment failures from behavior failures.

## Invariants
Canonical owners define requirements. Preserve authorized task scope and unrelated
work. This workflow grants no real mailbox permission and does not duplicate policy.

## Validation
Record actual commands/outcomes and skipped checks. Avoid implementation mirrors and claims of real Gmail validation from fakes.

## Expected output
Concise evidence, covered regressions and honest limits.

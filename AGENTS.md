# InboxGuardian MCP — agent entry point

Status: canonical routing; Phase 1 local foundation.

Mailbox analysis and sender-based cleanup through MCP. Gmail and synthetic mock
providers share a provider-independent domain. Start here before changing code.

## Progressive context

0. Read this file.
1. Choose task-relevant owners from [.context/INDEX.md](.context/INDEX.md).
2. Read the matching workflow below.
3. Inspect affected source and tests.
4. Expand context only to resolve a concrete dependency or uncertainty.

Do not load every document, skill, dependency tree, build artifact, Git history,
or mailbox payload by default. Full inventories are for broad audits.

## Sources of truth

| Responsibility | Owner |
| --- | --- |
| Product behavior and classification | [.context/PRODUCT.md](.context/PRODUCT.md) |
| Architecture and source navigation | [.context/ARCHITECTURE.md](.context/ARCHITECTURE.md) |
| Security, privacy, authorization and cleanup | [.context/SECURITY.md](.context/SECURITY.md) |
| Domain vocabulary and glossary | [.context/DOMAIN.md](.context/DOMAIN.md) |
| MCP contracts | [.context/MCP.md](.context/MCP.md) |
| Data lifecycle | [.context/DATA.md](.context/DATA.md) |
| Editing workflow | [.context/DEVELOPMENT.md](.context/DEVELOPMENT.md) |
| Validation expectations | [.context/TESTING.md](.context/TESTING.md) |
| Decision status and rationale | [.context/DECISIONS.md](.context/DECISIONS.md) |
| Machine retrieval | [.okf/manifest.yaml](.okf/manifest.yaml) |

Context owners define intended behavior; decisions record rationale, not another
policy. OKF and agent adapters point to owners. README explains setup and current
limitations. Resolve contradictions with task intent, accepted decisions and tests;
correct the wrong source rather than create competing instructions.

## Mandatory routing

- Read SECURITY before auth, tokens, account mutation, trash, bulk changes,
  confirmation, logging, mailbox processing or external AI access.
- Human approval must cross the trusted dashboard boundary; a model cannot mint it.
- Read TESTING for behavior changes and report checks actually run.
- Read DECISIONS before technology or architectural changes.
- Preserve unrelated user changes. Make the smallest coherent change.

## Local workflows

Portable workflows are loaded explicitly; automatic agent discovery is not assumed.

| Skill | Use when |
| --- | --- |
| [.skills/repository-audit/SKILL.md](.skills/repository-audit/SKILL.md) | Broad changes, onboarding, conflicting context |
| [.skills/mcp-tool-design/SKILL.md](.skills/mcp-tool-design/SKILL.md) | MCP contract changes |
| [.skills/destructive-action-safety/SKILL.md](.skills/destructive-action-safety/SKILL.md) | Trash, bulk mutation, approval, OAuth permissions |
| [.skills/testing/SKILL.md](.skills/testing/SKILL.md) | Selecting validation scope |
| [.skills/documentation-maintenance/SKILL.md](.skills/documentation-maintenance/SKILL.md) | Stable knowledge, README or routing updates |

Skills grant no permission to operate on a real mailbox. Current setup and commands
are in [README.md](README.md). Never use real credentials or mail in tests/context.

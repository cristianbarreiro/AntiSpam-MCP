# Context index

Status: canonical router. Load only the task's owners.

| Document | Read when / purpose | Skip when |
| --- | --- | --- |
| [PRODUCT.md](PRODUCT.md) | User behavior, classification, sender controls | Internal-only changes |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Boundaries, providers, module navigation | Wording-only edits |
| [SECURITY.md](SECURITY.md) | Auth, mail, mutation, logs, privacy | Unrelated formatting |
| [DOMAIN.md](DOMAIN.md) | Entities, identity, terminology | No domain impact |
| [MCP.md](MCP.md) | Tool/schema/transport behavior | No protocol impact |
| [DATA.md](DATA.md) | Persistence, caches, retention | No data lifecycle impact |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Editing workflow, context drift | Already understood this task |
| [TESTING.md](TESTING.md) | Behavior and contract validation | Editorial-only edits |
| [DECISIONS.md](DECISIONS.md) | Technology/status/design changes | Settled implementation details |

DOMAIN includes the glossary. [OKF](../.okf/manifest.yaml) is a local retrieval index,
not an independent policy. [AGENTS](../AGENTS.md) maps workflow skills.

## Future-task routes

| Scenario | Context | Workflow |
| --- | --- | --- |
| Sender statistics tool | MCP, DOMAIN, SECURITY for exposed mail | mcp-tool-design |
| Gmail trash changes | SECURITY, ARCHITECTURE, MCP; DATA if state changes | destructive-action-safety |
| Classification improvement | PRODUCT, DOMAIN, TESTING | testing |
| Add Outlook | ARCHITECTURE, DOMAIN, SECURITY, DECISIONS | testing |
| Update README | README and the changed claim's owner | documentation-maintenance |

Then read affected source/tests, never unrelated frontend or provider code by default.

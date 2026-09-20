# Development workflow

Status: canonical.

1. Start at AGENTS; load affected owners and the matching workflow.
2. Inspect affected source/tests and working-tree changes; preserve unrelated edits.
3. Identify security impact and resolve meaningful open decisions.
4. Make the smallest coherent change.
5. Run focused validation and required checks from TESTING.
6. Update stable context only when behavior, ownership or decisions changed.

Use targeted searches after the initial audit. Avoid generated dependencies/builds
and private .data/secrets content in context. Before destructive filesystem/Git
work, verify exact paths and scope. A development task authorizes fake-provider
changes and tests, not real mailbox cleanup.

Freshness: canonical status describes ownership, not completeness. No routine date
churn. If code and intended behavior differ, use requirements, decisions and tests
to correct the wrong source; never silently weaken safety rules to match a bug.

Run commands from repository root. README owns exact setup and commands. Default
mock mode needs no Google credentials. Keep stdout reserved for MCP protocol;
operational diagnostics go to stderr without private mail or credentials.

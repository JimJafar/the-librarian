# The Librarian Agent Instructions

This project uses The Librarian as its long-term memory system.

When you have access to The Librarian MCP tools, use the `use-the-librarian` skill before doing meaningful work. If your agent environment does not auto-load skills, read:

```text
skills/use-the-librarian/SKILL.md
```

Minimum required behavior:

1. Call `start_context` at the start of meaningful interactions.
2. Use `recall` before non-trivial project, tool, environment, or preference-sensitive work.
3. Use `remember` only for durable, specific, future-useful memories.
4. Use `propose_memory` for identity, relationship, and major preference memories.
5. Keep common memory separate from agent-private memory.
6. Use `verify_memory`, `update_memory`, `delete_memory`, and `resolve_conflict` to maintain memory hygiene.

Do not create competing ad hoc memory files unless the user explicitly asks.

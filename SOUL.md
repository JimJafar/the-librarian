# The Librarian Agent Instructions

You are to use The Librarian as your long-term memory system.

When you have access to The Librarian MCP tools, let the connect-time primer
(served as the MCP `instructions` field) and each tool's own description guide
you — they are the teaching surface (ADR 0006: there is no bundled "how to use
The Librarian" skill).

Minimum required behavior:

1. Use `recall` before non-trivial project, tool, environment, or preference-sensitive work.
2. Use `remember` only for durable, specific, future-useful memories — it routes identity, relationship, and major-preference memories to the curator inbox as proposals automatically (ADR 0004 / 0006).
3. Keep common memory separate from agent-private memory.
4. Use `flag_memory` to route a memory you found wrong, misleading, or outdated to review — never archive unilaterally.
5. Treat approval, deletion, and conflict resolution as admin/review actions (dashboard tRPC), not agent MCP calls, unless explicitly authorized.

Do not create competing ad hoc memory files unless the user explicitly asks.

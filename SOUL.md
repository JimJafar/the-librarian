# The Librarian Agent Instructions

You are to use The Librarian as your long-term memory system.

When you have access to The Librarian MCP tools, let the connect-time primer
(served as the MCP `instructions` field) and each tool's own description guide
you — they are the teaching surface (ADR 0006/0007: there is no bundled "how
to use The Librarian" skill).

Minimum required behavior:

1. Use `recall` before non-trivial project, tool, environment, or preference-sensitive work.
2. Use `remember` only for durable, specific, future-useful memories — it is fire-and-forget into the curator's intake inbox; the curator files, merges, or proposes as needed (ADR 0004 / 0006).
3. Use `flag_memory` to route a memory you found wrong, misleading, or outdated to review — never archive unilaterally.
4. Honor private mode: while the `[librarian:private=on]` marker is in effect, make no writes (`remember`, `store_handoff`, `flag_memory`).
5. Treat approval, deletion, and conflict resolution as admin/review actions (dashboard tRPC), not agent MCP calls, unless explicitly authorized.

Do not create competing ad hoc memory files unless the user explicitly asks.

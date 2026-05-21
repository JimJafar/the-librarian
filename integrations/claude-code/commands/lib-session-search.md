---
description: Search Librarian sessions by event content
---

Search Librarian session summaries and events via the `search_sessions` MCP tool.

Arguments (`$ARGUMENTS`): the query. Quote multi-word queries naturally — pass the full argument string as `query`.

Defaults to apply:
- `project_key`: inferred from CLAUDE.md / project root (omit if the user wants cross-project search)
- `include_ended`: omit (default false). Pass `include_ended: true` only if `$ARGUMENTS` contains `--include-ended` (also accepted as legacy `--archived` or `--deleted`).
- `limit`: 5 by default

Default scope is `active + paused`. The three-state model collapsed `archived` and `deleted` into `ended`, so ended sessions are hidden by default — pass `--include-ended` to surface them.

Render matches as numbered entries (title, status, project, id). Remind the reader that numbers are agent-side scratch — `/lib-session-resume` will accept either the number or the canonical `session_id`.

Canonical contract: [`docs/slash-commands.md`](../../docs/slash-commands.md).

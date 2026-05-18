---
description: List resumable Librarian sessions
---

List resumable Librarian sessions via the `list_sessions` MCP tool.

Defaults to apply:
- `project_key`: inferred from CLAUDE.md / project root
- `cwd`: current working directory
- `harness`: `"claude-code"` only when the user clearly wants Claude-Code-only results; leave unset to see sessions startable across harnesses
- `include_archived` / `include_deleted`: omit (default false) unless `$ARGUMENTS` contains `--archived` / `--deleted`

Render the result as numbered entries with status, title, project, harness, source, last activity, and the first next step. Remind the reader that the numbers are agent-side scratch — every subsequent tool call uses the canonical `session_id`.

Do NOT auto-resume. The user must explicitly run `/lib-session-resume <n|session_id>` next.

Canonical contract: [`docs/slash-commands.md`](../../docs/slash-commands.md).

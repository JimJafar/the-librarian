---
description: List resumable Librarian sessions
---

List resumable Librarian sessions via the `list_sessions` MCP tool.

Defaults to apply:
- `project_key`: inferred from AGENTS.md / project root
- `cwd`: current working directory
- `harness`: `"opencode"` only when the user clearly wants OpenCode-only results; leave unset to see sessions startable across harnesses
- `include_ended`: omit (default false). Pass `include_ended: true` only if `$ARGUMENTS` contains `--include-ended` (also accepted as legacy `--archived` or `--deleted`).

Default scope is `active + paused`. The three-state model collapsed `archived` and `deleted` into `ended`, so ended sessions are hidden by default — pass `--include-ended` to surface them.

Render the result as numbered entries with status, title, project, harness, source, last activity, and the first next step. Remind the reader that the numbers are agent-side scratch — every subsequent tool call uses the canonical `session_id`.

Do NOT auto-resume. The user must explicitly run `/lib-session-resume <n|session_id>` next (or `/lib-session-resume` with no argument for the inline list-and-select flow).

Canonical contract: [`docs/slash-commands.md`](../../../docs/slash-commands.md).

---
description: Start a new Librarian session
---

Start a new Librarian session via the `start_session` MCP tool.

Arguments (`$ARGUMENTS`): optional title as free text. The token `--private` sets `visibility: agent_private`.

Defaults to apply:
- `harness: "claude-code"`
- `cwd`: current working directory
- `project_key`: inferred from CLAUDE.md / project root
- `source_ref`: `claude:session:${CLAUDE_SESSION_ID}` when that env var is set, else `cwd:<absolute path>`
- `visibility`: `common` unless `--private` is supplied
- `capture_mode`: `summary`
- `start_summary`: build from currently visible context (recent user prompt, open files, work in progress)

Sensitivity check: before calling, scan the visible context for sensitivity signals (identity claims, secrets, personal context, sensitive debugging). If any are present and `--private` was NOT supplied, ask the user to confirm before starting a common-visibility session.

After calling: report the new `session_id`, visibility, and a one-paragraph baseline. Keep the `session_id` in conversational state — subsequent `/lib-session-*` calls assume it as the active session unless the user names another.

Canonical contract: [`docs/slash-commands.md`](../../docs/slash-commands.md).

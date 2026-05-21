---
description: Resume a Librarian session (fetch handover + attach)
---

Resume a Librarian session via the `continue_session` MCP tool.

Arguments (`$ARGUMENTS`): `<number|session_id>` (optional).

- If `$ARGUMENTS` is a `ses_…` id: resolve directly.
- If `$ARGUMENTS` is a number: resolve against the most recent in-conversation `list_sessions` response (agent-side scratch).
- If `$ARGUMENTS` is empty: do the inline list-and-select flow:
  1. Call `list_sessions` scoped to the current harness + cwd (defaults from `/lib-session-list`).
  2. Render the numbered results as a short list (status, title, project, last activity, first next step).
  3. Ask the user to pick a number or paste a `ses_…` id.
  4. Resolve the choice and continue with the resume flow below.

  Do NOT auto-select. Even a single-item list still requires user confirmation.

Defaults for `continue_session` (once a `session_id` is resolved; `attach: true` is the default):
- `target_harness: "opencode"`
- `target_cwd`: current working directory
- `target_source_ref`: `opencode:project:<cwd>:session:${OPENCODE_SESSION_ID}` when set, else `opencode:project:<cwd>`
- `format`: `opencode` by default (pass `--format <name>` through if the user specifies)

Resume works on `ended` sessions too — the call flips them back to `paused`, then the first recorded event flips them to `active`. There is no separate restore verb under the three-state model.

After calling: display the handover text returned by the tool. Keep the resumed `session_id` in conversational state.

Canonical contract: [`docs/slash-commands.md`](../../../docs/slash-commands.md).

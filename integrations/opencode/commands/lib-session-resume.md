---
description: Resume a Librarian session (fetch handover + attach)
---

Resume a Librarian session via the `continue_session` MCP tool.

Arguments (`$ARGUMENTS`): `<number|session_id>`. A number refers to the last `/lib-session-list` response; resolve it to a canonical `session_id` from agent-side scratch. If no list has been run in this conversation and the argument isn't a `ses_…` id, ask the user to run `/lib-session-list` first.

Defaults to apply (`attach: true` is the default for `continue_session`):
- `target_harness: "opencode"`
- `target_cwd`: current working directory
- `target_source_ref`: `opencode:project:<cwd>:session:${OPENCODE_SESSION_ID}` when set, else `opencode:project:<cwd>`
- `format`: `opencode` by default (pass `--format <name>` through if the user specifies)

After calling: display the handover text returned by the tool. Keep the resumed `session_id` in conversational state.

Canonical contract: [`docs/slash-commands.md`](../../../docs/slash-commands.md).

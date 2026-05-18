---
description: Checkpoint the active Librarian session (updates rolling_summary, stays active)
---

Checkpoint the active Librarian session via the `checkpoint_session` MCP tool.

Use the `session_id` you've been carrying in conversational state since the last `/lib-session-start` or `/lib-session-resume`. If you don't have one, ask the user (or run `/lib-session-list` and let them pick).

Build the call yourself — the user typed `/lib-session-checkpoint` without expecting to write a summary:
- `summary`: a concise paragraph covering work since session start or the previous checkpoint
- `decisions`: explicit decisions made since the last checkpoint
- `files_touched`: files edited or created
- `commands_run`: commands actually executed (not proposed)
- `open_questions`: anything still unresolved
- `next_steps`: ordered list of what's next

Keeps the session `active`. After calling: confirm the new rolling_summary back to the user in one sentence.

Canonical contract: [`docs/slash-commands.md`](../../../docs/slash-commands.md).

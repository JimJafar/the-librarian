---
description: Pause the active Librarian session
---

Pause the active Librarian session via the `pause_session` MCP tool.

Use the `session_id` you've been carrying since the last `/lib-session-start` or `/lib-session-resume`. If you don't have one, ask the user.

Build the call:
- `summary`: a short pause summary (where the work is parked, how to pick it up)
- `next_steps`: ordered list of what's next when resumed

After calling: confirm the session is paused. Activity on the session (a record/checkpoint call) will implicitly resume it later.

Canonical contract: [`docs/slash-commands.md`](../../docs/slash-commands.md).

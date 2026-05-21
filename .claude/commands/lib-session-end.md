---
description: End the active Librarian session
---

End the active Librarian session via the `end_session` MCP tool.

Use the `session_id` you've been carrying since the last `/lib-session-start` or `/lib-session-resume`. If you don't have one, ask the user.

Build the call:
- `summary`: optional. Final summary drawn from `start_summary` + checkpoints + currently visible context. Omit for the "I'm done with this session" abandonment path — there is no separate archive/delete verb under the three-state model.
- `decisions`, `files_touched`, `commands_run`, `open_questions`, `next_steps`: as for checkpoint
- `candidate_memories`: optional — facts that look worth promoting to durable memory

After calling: report the end summary (if provided) and the next steps. Surface candidate durable memories as a numbered list but DO NOT auto-promote — wait for the user to explicitly ask for `promote_session_fact` (or `remember` / `propose_memory`).

Ended is not terminal — `/lib-session-resume <id>` brings the session back as `paused`, and the next recorded event flips it to `active`. There is no separate `restore` verb.

Canonical contract: [`docs/slash-commands.md`](../../docs/slash-commands.md).

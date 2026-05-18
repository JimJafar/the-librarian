---
description: End the active Librarian session
---

End the active Librarian session via the `end_session` MCP tool.

Use the `session_id` you've been carrying since the last `/lib-session-start` or `/lib-session-resume`. If you don't have one, ask the user.

Build the call:
- `summary`: final summary drawn from `start_summary` + checkpoints + currently visible context
- `decisions`, `files_touched`, `commands_run`, `open_questions`, `next_steps`: as for checkpoint
- `candidate_memories`: optional — facts that look worth promoting to durable memory

After calling: report the end summary and the next steps. Surface candidate durable memories as a numbered list but DO NOT auto-promote — wait for the user to explicitly ask for `promote_session_fact` (or `remember` / `propose_memory`).

`ended` is terminal — to continue the work, start a new session with `metadata.continues_from` referencing this id.

Canonical contract: [`docs/slash-commands.md`](../../../docs/slash-commands.md).

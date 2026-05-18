---
description: Show the currently attached Librarian session for this harness/source
---

Show the currently attached Librarian session.

Resolution order:
1. If you've been carrying a `session_id` in conversational state since the last `/lib-session-start` or `/lib-session-resume`, use that.
2. Otherwise call `list_sessions` scoped to `harness: "opencode"` and current `cwd`, sort by `last_activity_at`, and treat the most recent as the candidate.
3. If nothing matches, report that no session is attached for this harness/cwd.

For the chosen session, call `get_session` and render:
- title, status, visibility, project
- created in vs. current harness/source
- start_summary, rolling_summary, end_summary (when present)
- next_steps
- last activity timestamp

Then list the last few events via `list_session_events` (limit 5) so the user sees what's happened recently.

Canonical contract: [`docs/slash-commands.md`](../../../docs/slash-commands.md).

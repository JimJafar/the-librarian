---
description: Restore an archived or soft-deleted Librarian session
---

Restore an archived or soft-deleted Librarian session via the `restore_session` MCP tool.

Arguments (`$ARGUMENTS`): `<number|session_id>`. Numbers resolve from the last `/lib-session-list` response (run with `--archived` or `--deleted` first to see hidden sessions).

Owner-or-admin only — the store will reject restores by non-owner agents. If the call errors with an ownership message, surface it verbatim.

After calling: report the restored session's new status (its `prior_status`, falling back to `paused`).

Canonical contract: [`docs/slash-commands.md`](../../docs/slash-commands.md).

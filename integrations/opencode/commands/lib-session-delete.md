---
description: Soft-delete a Librarian session (owner-or-admin)
---

Soft-delete a Librarian session via the `delete_session` MCP tool.

Arguments (`$ARGUMENTS`): `<number|session_id> [reason...]`. Resolve a number from the last `/lib-session-list` response. Everything after the id is the optional `reason` string.

Before calling: ask the user to confirm in a single short sentence — soft-delete is reversible via `/lib-session-restore`, but it removes the session from default lists and search.

Owner-or-admin only — the store will reject deletes by non-owner agents. If the call errors with an ownership message, surface it verbatim and stop (don't retry as admin without explicit user direction).

Canonical contract: [`docs/slash-commands.md`](../../../docs/slash-commands.md).

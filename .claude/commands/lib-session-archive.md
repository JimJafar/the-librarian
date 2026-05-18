---
description: Archive a Librarian session (hide from default lists)
---

Archive a Librarian session via the `archive_session` MCP tool.

Arguments (`$ARGUMENTS`): `<number|session_id> [reason...]`. Resolve a number from the last `/lib-session-list` response. Everything after the id is the optional `reason` string.

After calling: confirm the session is archived. It will be hidden from default `/lib-session-list` results but visible with `--archived` (and searchable with `include_archived`). Restorable via `/lib-session-restore`.

Canonical contract: [`docs/slash-commands.md`](../../docs/slash-commands.md).

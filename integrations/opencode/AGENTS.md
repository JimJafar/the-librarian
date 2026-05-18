# Librarian session layer (OpenCode)

Drop this file into the project root (or merge with an existing `AGENTS.md`).

## What you have access to

The Librarian's HTTP MCP server is connected. Available session tools include `start_session`, `list_sessions`, `continue_session`, `checkpoint_session`, `pause_session`, `end_session`, `archive_session`, `restore_session`, `delete_session`, `search_sessions`, `get_session`, `list_session_events`, `record_session_event`, `attach_session`, `promote_session_fact`, plus the full memory tool surface.

## The `/lib-session-*` slash commands

This package ships **native OpenCode slash commands** — one per verb — as markdown files under `commands/`. Install by copying them into `.opencode/commands/` (or `~/.config/opencode/commands/` for user-global use). OpenCode dispatches them natively with autocompletion; the agent never has to parse `/lib-session-*` out of free text.

The 11 commands:

- `/lib-session-start [title] [--private]` — bound the work.
- `/lib-session-list` — show resumable sessions; never auto-select. Numbered entries are agent-side scratch; tool calls use the canonical `session_id`.
- `/lib-session-resume <number|session_id>` — fetch handover and attach.
- `/lib-session-checkpoint` / `/lib-session-pause` / `/lib-session-end`.
- `/lib-session-archive` / `/lib-session-restore` / `/lib-session-delete` — delete and restore are owner-or-admin.
- `/lib-session-search <query>`.
- `/lib-session-status`.

The hyphenated names match OpenCode's filename-as-command convention; the canonical cross-harness contract uses `/lib:session <verb>` as the abstract surface (see [`docs/slash-commands.md`](../../docs/slash-commands.md)) and each harness implements it with whichever native pattern best fits.

## `source_ref` for OpenCode

Use the project-oriented form:

- Preferred: `opencode:project:{absolute_path}` plus an OpenCode session id if available.
- Fallback: `cwd:{absolute_path}`.

The wrapper script in this package populates `LIBRARIAN_SESSION_ID` for child processes; respect it when recording events.

## Capture mode

Default to `summary`. Never enable raw `log` capture by default.

## Visibility (Principle 9)

Sessions default to `common`. Before starting a `common` session, scan the surrounding context for sensitivity signals (identity, secrets, personal context, sensitive debugging). If signals are present and `--private` was not supplied, **confirm with the user before starting**.

## Boundaries

- Session history is **evidence**, not durable memory. Promote selectively via `/lib:session end`'s candidates or `promote_session_fact`.
- Use `remember` / `propose_memory` for durable facts. Protected categories (identity, relationship) always route to proposals.
- Do not auto-promote anything from session content.

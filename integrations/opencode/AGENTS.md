# Librarian session layer (OpenCode)

Drop this file into the project root (or merge with an existing `AGENTS.md`).

## What you have access to

The Librarian's HTTP MCP server is connected. Available session tools include `start_session`, `list_sessions`, `continue_session`, `checkpoint_session`, `pause_session`, `end_session`, `search_sessions`, `get_session`, `list_session_events`, `record_session_event`, `attach_session`, `promote_session_fact`.

The full memory tool surface is also available: `start_context`, `recall`, `remember`, `propose_memory`, `update_memory`, `verify_memory`, `list_proposals`. (`archive_memory` and `approve_proposal` are admin-only — they appear only when authenticated with an admin token.)

## The `/lib-session-*` slash commands

This package ships **native OpenCode slash commands** — one per verb — as markdown files under `commands/`. Install by copying them into `.opencode/commands/` (or `~/.config/opencode/commands/` for user-global use). OpenCode dispatches them natively with autocompletion; the agent never has to parse `/lib-session-*` out of free text.

The 7 commands:

- `/lib-session-start [title] [--private]` — bound the work.
- `/lib-session-list [--include-ended]` — show resumable sessions; never auto-select. Default scope `active + paused`. Numbered entries are agent-side scratch; tool calls use the canonical `session_id`.
- `/lib-session-resume [<number|session_id>]` — fetch handover and attach. With no argument, the command does an inline list-and-select flow. Works on `ended` sessions (flips them back to `paused`).
- `/lib-session-checkpoint` / `/lib-session-pause` / `/lib-session-end`. `end`'s summary is optional — bare call is the "I'm done with this session" abandonment path.
- `/lib-session-search <query>`.

Sessions are in one of three states: `active`, `paused`, `ended`. The retired verbs `archive`, `restore`, `delete`, `status` were removed when the three-state model landed.

Memories are in one of three states: `active`, `proposed`, or `archived`. `active` is the recall pool; `proposed` is awaiting human approval (auto-routed for protected categories like `identity` and `relationship`); `archived` is the soft-deleted bucket. The retired verbs `delete_memory`, `confirm_memory`, `reject_memory`, and the conflict-resolution surface were removed when the three-state model landed — `archive_memory` covers deletion, proposals are accepted or rejected through the dashboard or `update_memory`, and conflict detection is gone.

## Verify-after-recall

When `recall` returns hits and you use one, call `verify_memory` afterwards with a usefulness verdict so the store learns:

- `useful` — the hit was load-bearing for the answer. Boosts recall rank by 3.
- `not_useful` — the hit was a distractor or stale framing. Drops recall rank by 3.
- `outdated` — the memory is factually wrong now. Archives it.

The verdict is a single MCP call; don't skip it because the recall already gave you the answer. The whole memory-quality loop depends on these signals.

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

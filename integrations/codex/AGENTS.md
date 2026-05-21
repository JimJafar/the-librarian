# Librarian session layer (Codex)

Drop this file into the project root (or merge with an existing `AGENTS.md`). Codex reads it on session start and uses it to drive `/lib:session` commands.

## What you have access to

The Librarian's HTTP MCP server is connected. Available session tools include `start_session`, `list_sessions`, `continue_session`, `checkpoint_session`, `pause_session`, `end_session`, `search_sessions`, `get_session`, `list_session_events`, `record_session_event`, `attach_session`, `promote_session_fact`.

The full memory tool surface (`start_context`, `recall`, `remember`, `propose_memory`, etc.) is also available — unchanged from before the session layer landed.

## The `/lib:session` surface

`/lib:session` commands are **textual commands handled by the agent**. When the user types `/lib:session start ...`, recognise the form and route to the corresponding MCP tool.

The canonical contract lives in [`docs/slash-commands.md`](../../docs/slash-commands.md). Highlights:

- `/lib:session start [title] [--private]` — bound the work, build a baseline from current visible context.
- `/lib:session list [--include-ended]` — show resumable sessions; never auto-select. Default scope `active + paused`. Numbered entries are agent-side scratch — every tool call uses the canonical `session_id`.
- `/lib:session resume [<number|session_id>]` — fetch handover and attach in one call. With no argument, the agent does the inline list-and-select flow. Works on `ended` sessions (flips them back to `paused`).
- `/lib:session checkpoint` / `pause` / `end` — explicit lifecycle. Process exit should generally pause, not end. `end`'s summary is optional — the bare call is the "I'm done with this session" abandonment path.
- `/lib:session search <query>` — full-text search across session events.

Sessions are in one of three states: `active`, `paused`, `ended`. The retired verbs `archive`, `restore`, `delete`, `status` were removed when the three-state model landed — `end` covers archive/delete, `resume` covers restore, and `list` scoped to the current harness covers status.

## `source_ref` for Codex

Codex is cwd-oriented. Use the most specific form available:

- Preferred: `codex:run:{CODEX_RUN_ID}:cwd:{absolute_path}` when a run id is available.
- Fallback: `cwd:{absolute_path}`.

The wrapper script in this package will populate `LIBRARIAN_SESSION_ID` for child processes; respect it when recording events.

## Capture mode

Default to `summary`. Never enable raw `log` capture by default.

## Visibility (Principle 9)

Sessions default to `common`. Before starting a `common` session, scan the surrounding context (files, prompts) for sensitivity signals (identity claims, secrets, personal context, sensitive debugging). If signals are present and `--private` was not supplied, **confirm with the user before starting**.

## Boundaries

- Session history is **evidence**, not durable memory. Promote selectively via `/lib:session end`'s candidates or `promote_session_fact`.
- Use `remember` / `propose_memory` for durable facts. Protected categories (identity, relationship) always route to proposals.
- Do not auto-promote anything from session content.

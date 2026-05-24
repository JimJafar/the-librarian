# Librarian session layer (Codex)

Drop this file into the project root (or merge with an existing `AGENTS.md`). Codex reads it on session start and uses it to drive `/lib:session` commands.

## What you have access to

The Librarian's HTTP MCP server is connected. Available session tools include `start_session`, `list_sessions`, `continue_session`, `checkpoint_session`, `pause_session`, `end_session`, `search_sessions`, `get_session`, `list_session_events`, `record_session_event`, `attach_session`, `promote_session_fact`.

The full memory tool surface is also available: `start_context`, `recall`, `remember`, `propose_memory`, `update_memory`, `verify_memory`, `list_proposals`. (`archive_memory` and `approve_proposal` are admin-only — they appear only when authenticated with an admin token.)

## The `/lib:session` surface

`/lib:session` commands are **textual commands handled by the agent**. When the user types `/lib:session start ...`, recognise the form and route to the corresponding MCP tool.

The canonical contract lives in [`docs/slash-commands.md`](../../docs/slash-commands.md). Highlights:

- `/lib:session start [title] [--private]` — bound the work, build a baseline from current visible context.
- `/lib:session list [--include-ended]` — show resumable sessions; never auto-select. Default scope `active + paused`. Numbered entries are agent-side scratch — every tool call uses the canonical `session_id`.
- `/lib:session resume [<number|session_id>]` — fetch handover and attach in one call. With no argument, the agent does the inline list-and-select flow. Works on `ended` sessions (flips them back to `paused`).
- `/lib:session checkpoint` / `pause` / `end` — explicit lifecycle. Process exit should generally pause, not end. `end`'s summary is optional — the bare call is the "I'm done with this session" abandonment path.
- `/lib:session search <query>` — full-text search across session events.

Sessions are in one of three states: `active`, `paused`, `ended`. The retired verbs `archive`, `restore`, `delete`, `status` were removed when the three-state model landed — `end` covers archive/delete, `resume` covers restore, and `list` scoped to the current harness covers status.

Memories are in one of three states: `active`, `proposed`, or `archived`. `active` is the recall pool; `proposed` is awaiting human approval (auto-routed for protected categories like `identity` and `relationship`); `archived` is the soft-deleted bucket. The retired verbs `delete_memory`, `confirm_memory`, `reject_memory`, and the conflict-resolution surface were removed when the three-state model landed — `archive_memory` covers deletion, proposals are accepted or rejected through the dashboard or `update_memory`, and conflict detection is gone.

## Verify-after-recall

When `recall` returns hits and you use one, call `verify_memory` afterwards with a usefulness verdict so the store learns:

- `useful` — the hit was load-bearing for the answer. Boosts recall rank by 3.
- `not_useful` — the hit was a distractor or stale framing. Drops recall rank by 3.
- `outdated` — the memory is factually wrong now. Archives it.

The verdict is a single MCP call; don't skip it because the recall already gave you the answer. The whole memory-quality loop depends on these signals.

## `source_ref` for Codex

Codex is cwd-oriented. Use the most specific form available:

- Preferred: `codex:run:{CODEX_RUN_ID}:cwd:{absolute_path}` when a run id is available.
- Fallback: `cwd:{absolute_path}`.

The wrapper script in this package will populate `LIBRARIAN_SESSION_ID` for child processes; respect it when recording events.

## Privacy / off-record (`/lib-toggle-private` and markers)

When the lifecycle hooks are enabled (`[features] hooks = true`), the `UserPromptSubmit` hook is the real privacy gate: typing `/lib-toggle-private` or an off-record marker ("off the record", "don't remember this", …) flips local off-record mode synchronously, before you act, and ends the attached session with a neutral reason. You don't need to do anything.

**When hooks are off, this is best-effort and on you:** if the user types `/lib-toggle-private` or says they're going off the record, treat the rest of that turn as private — make **no** Librarian session/memory calls and do not start a session — until they say recording can resume. Without the hook there is no synchronous enforcement, so err toward not recording. See `docs/slash-commands.md` (`/lib:toggle-private`).

## Capture mode

Default to `summary`. Never enable raw `log` capture by default.

## Visibility (Principle 9)

Sessions default to `common`. Before starting a `common` session, scan the surrounding context (files, prompts) for sensitivity signals (identity claims, secrets, personal context, sensitive debugging). If signals are present and `--private` was not supplied, **confirm with the user before starting**.

## Boundaries

- Session history is **evidence**, not durable memory. Promote selectively via `/lib:session end`'s candidates or `promote_session_fact`.
- Use `remember` / `propose_memory` for durable facts. Protected categories (identity, relationship) always route to proposals.
- Do not auto-promote anything from session content.

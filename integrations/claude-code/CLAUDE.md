# Librarian session layer (Claude Code)

Drop this file into the project root (or merge with an existing `CLAUDE.md`). Claude Code reads it on session start and uses it to drive `/lib:session` commands.

## What you have access to

The Librarian's HTTP MCP server is connected. Available session tools:

- `start_session`, `get_session`, `list_sessions`, `list_session_events`, `search_sessions`
- `record_session_event`, `checkpoint_session`, `pause_session`, `end_session`
- `attach_session`, `continue_session`
- `promote_session_fact`

The full memory tool surface is also available: `start_context`, `recall`, `remember`, `propose_memory`, `update_memory`, `verify_memory`, `list_proposals`. (`archive_memory` and `approve_proposal` are admin-only — they appear only when authenticated with an admin token.)

## The `/lib-session-*` slash commands

This package ships **native Claude Code slash commands** — one per verb — under `.claude/commands/`. Each is a thin markdown prompt that tells the agent which MCP tool to call with which scoping. Typing `/lib-session-` will autocomplete the verb list:

- `/lib-session-start [title] [--private]` — bound the work, build a baseline from current visible context, return a `session_id`.
- `/lib-session-list [--include-ended]` — show resumable sessions; never auto-select. Default scope is `active + paused`; `--include-ended` also surfaces `ended` sessions. Numbered entries are agent-side scratch — every tool call uses the canonical `session_id`.
- `/lib-session-resume [<number|session_id>]` — fetch handover and attach in one call (default `attach: true`). With no argument, the command does an inline list-and-select flow. Works on `ended` sessions (flips them to `paused`).
- `/lib-session-checkpoint` / `/lib-session-pause` / `/lib-session-end` — explicit lifecycle. Process exit should generally pause, not end. `end`'s summary is optional — the bare call is the "I'm done with this session" abandonment path.
- `/lib-session-search <query>` — full-text search across session events.
- `/lib-toggle-private` — toggle off-record mode (outside the session family). Local privacy control enforced by the `UserPromptSubmit` hook; going private ends the attached session with a neutral reason and stops automatic recording until you toggle back. Natural-language markers ("off the record", "don't remember this") do the same directionally.

Sessions are always in one of three states: `active`, `paused`, or `ended`. The legacy `archived`, `deleted`, and `status` verbs were removed when the three-state model landed — `end` covers archive/delete, `resume` covers restore, and `list` scoped to the current harness covers status.

Memories are in one of three states: `active`, `proposed`, or `archived`. `active` is the recall pool; `proposed` is awaiting human approval (auto-routed for protected categories like `identity` and `relationship`); `archived` is the soft-deleted bucket. The retired verbs `delete_memory`, `confirm_memory`, `reject_memory`, and the conflict-resolution surface were removed when the three-state model landed — `archive_memory` covers deletion, proposals are accepted or rejected through the dashboard or `update_memory`, and conflict detection is gone.

## Verify-after-recall

When `recall` returns hits and you use one, call `verify_memory` afterwards with a usefulness verdict so the store learns:

- `useful` — the hit was load-bearing for the answer. Boosts recall rank by 3.
- `not_useful` — the hit was a distractor or stale framing. Drops recall rank by 3.
- `outdated` — the memory is factually wrong now. Archives it.

The verdict is a single MCP call; don't skip it because the recall already gave you the answer. The whole memory-quality loop depends on these signals.

The hyphenated names match Claude Code's command-naming conventions; the canonical cross-harness contract uses `/lib:session <verb>` as the abstract surface (see [`docs/slash-commands.md`](../../docs/slash-commands.md)), but each harness implements it with whatever native pattern best fits — for Claude Code that's per-verb commands.

## `source_ref` for Claude Code

Use the most specific form Claude Code exposes:

- Preferred: `claude:session:{CLAUDE_SESSION_ID}` when the env var is set.
- Fallback: `cwd:{absolute_path}` when no native id is available.

The wrapper script in this package will populate `LIBRARIAN_SESSION_ID` for child processes; respect it when recording events.

## Native resume vs. Librarian sessions

Claude's `--resume` continues a Claude session inside Claude. The Librarian session is a **neutral handover layer** that lets the work cross harnesses (Hermes, Codex, OpenCode, Pi). Both can coexist:

- For in-Claude continuity, use `--resume`.
- For cross-harness or out-of-Claude review/handover, use `/lib-session-resume <id>` or fetch the handover via `the-librarian sessions continue <id> --format claude`.

## Capture mode

Default to `summary`. Never enable raw `log` capture by default — it's reserved for explicit operator request.

## Visibility (Principle 9)

Sessions default to `common` because cross-agent handover is the point of the layer. Before starting a `common` session, scan the surrounding context for sensitivity signals (identity claims, secrets, personal context, sensitive debugging). If signals are present and `--private` was not supplied, **confirm with the user before starting**.

## Boundaries

- Session history is **evidence**, not durable memory. Promote selectively via `/lib-session-end` candidates or `promote_session_fact`.
- Use `remember` / `propose_memory` for durable facts. Protected categories (identity, relationship) always route to proposals.
- Do not auto-promote anything from session content.

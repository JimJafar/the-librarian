# Librarian session layer (Pi)

Minimal system-prompt snippet for Pi-hosted agents.

## What you have access to

The Librarian's session and memory tools are available. Use `/lib:session` (textual command, recognised in user input) for the session lifecycle and `remember` / `propose_memory` for durable facts.

The memory tool surface: `start_context`, `recall`, `remember`, `propose_memory`, `update_memory`, `verify_memory`, `list_proposals`. (`archive_memory` and `approve_proposal` are admin-only.)

## The `/lib:session` surface

`/lib:session` commands are **textual commands handled by the agent**. The canonical contract lives in [`docs/slash-commands.md`](../../docs/slash-commands.md):

- `/lib:session start [title] [--private]` — bound the work.
- `/lib:session list [--include-ended]` — show resumable sessions. Default scope `active + paused`. Numbered entries are agent-side scratch; tool calls use canonical `session_id`.
- `/lib:session resume [<number|session_id>]` — fetch handover and attach. With no argument, do the inline list-and-select flow. Works on `ended` sessions (flips them back to `paused`).
- `/lib:session checkpoint` / `pause` / `end`. `end`'s summary is optional — bare call is the abandonment path.
- `/lib:session search <query>`.

Sessions are in one of three states: `active`, `paused`, `ended`. The retired verbs `archive`, `restore`, `delete`, `status` were removed when the three-state model landed.

Memories are in one of three states: `active`, `proposed`, or `archived`. `active` is the recall pool; `proposed` is awaiting human approval (auto-routed for protected categories like `identity` and `relationship`); `archived` is the soft-deleted bucket. The retired verbs `delete_memory`, `confirm_memory`, `reject_memory`, and the conflict-resolution surface were removed when the three-state model landed — `archive_memory` covers deletion, proposals are accepted or rejected through the dashboard or `update_memory`, and conflict detection is gone.

## Verify-after-recall

When `recall` returns hits and you use one, call `verify_memory` afterwards with a usefulness verdict so the store learns:

- `useful` — the hit was load-bearing for the answer. Boosts recall rank by 3.
- `not_useful` — the hit was a distractor or stale framing. Drops recall rank by 3.
- `outdated` — the memory is factually wrong now. Archives it.

The verdict is a single MCP call; don't skip it because the recall already gave you the answer. The whole memory-quality loop depends on these signals.

## `source_ref` for Pi

Use the most specific form available:

- `pi:device:{device_id}:session:{session_id}` when both ids exist.
- `pi:device:{device_id}` as a fallback.
- `cwd:{absolute_path}` if no device id is available.

## Capture mode

Default to **`summary`** (or `off` on constrained devices). **Never `log`** for Pi traffic without explicit operator consent.

## Visibility (Principle 9)

Sessions default to `common`. Before starting a `common` session, scan the surrounding context for sensitivity signals (identity, secrets, personal context, sensitive debugging). If signals are present and `--private` was not supplied, **confirm with the user before starting**.

## Boundaries

- Session history is **evidence**, not durable memory. Promote selectively via `/lib:session end`'s candidates or `promote_session_fact`.
- Use `remember` / `propose_memory` for durable facts. Protected categories (identity, relationship) always route to proposals.
- Do not auto-promote anything from session content.

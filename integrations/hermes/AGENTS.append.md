# Librarian session layer (Hermes)

Append this block to Hermes's existing `AGENTS.md`. It tells Hermes agents how to use The Librarian's session layer over Discord and other Hermes surfaces.

## The `/lib:session` surface

All session lifecycle goes through `/lib:session <verb>`. The canonical contract lives in [`docs/slash-commands.md`](../../docs/slash-commands.md). Highlights:

- `/lib:session start [title] [--private]` — bound the work, build a baseline from current visible context, return a `session_id`.
- `/lib:session list [--include-ended]` — show resumable sessions; never auto-select. Default scope `active + paused`. Numbered entries are agent-side scratch — every tool call uses the canonical `session_id`.
- `/lib:session resume [<number|session_id>]` — fetch handover and attach in one call (default `attach: true`). With no argument, do the inline list-and-select flow. Works on `ended` sessions (flips them back to `paused`).
- `/lib:session checkpoint` / `pause` / `end` — explicit lifecycle. Harness exit should generally pause, not end. `end`'s summary is optional — the bare call is the "I'm done with this session" abandonment path.
- `/lib:session search <query>` — full-text search across session events.

Sessions are in one of three states: `active`, `paused`, `ended`. The retired verbs `archive`, `restore`, `delete`, `status` were removed when the three-state model landed — `end` covers archive/delete, `resume` covers restore, and `list` scoped to the current harness covers status.

Memories are in one of three states: `active`, `proposed`, or `archived`. `active` is the recall pool; `proposed` is awaiting human approval (auto-routed for protected categories like `identity` and `relationship`); `archived` is the soft-deleted bucket. The retired verbs `delete_memory`, `confirm_memory`, `reject_memory`, and the conflict-resolution surface were removed when the three-state model landed — `archive_memory` covers deletion, proposals are accepted or rejected through the dashboard or `update_memory`, and conflict detection is gone.

## Verify-after-recall

When `recall` returns hits and you use one, call `verify_memory` afterwards with a usefulness verdict so the store learns:

- `useful` — the hit was load-bearing for the answer. Boosts recall rank by 3.
- `not_useful` — the hit was a distractor or stale framing. Drops recall rank by 3.
- `outdated` — the memory is factually wrong now. Archives it.

The verdict is a single MCP call; don't skip it because the recall already gave you the answer. The whole memory-quality loop depends on these signals.

## `source_ref` for Hermes

Use the Discord channel + thread identifiers as the source reference:

```
discord:channel:{channel_id}:thread:{thread_id}
```

A surface without a thread (e.g. a top-level channel) uses `discord:channel:{channel_id}` and acknowledges in the start summary that no thread is bound. Multiple Librarian sessions can attach to the same Discord thread over time — **the thread is a container, not a session**.

## Long-thread policy

A long-running Discord thread can hold many unrelated sessions. The session layer enforces evidence boundaries through agent policy, not through the store:

1. `/lib:session start` defines the lower bound for future summaries.
2. `/lib:session checkpoint` summarises from the previous checkpoint or session start — not from the top of the thread.
3. `/lib:session end` summarises from `start_summary + checkpoints + current visible context`.
4. Do NOT summarise messages from before the session start unless Jim explicitly asks.
5. If Jim asks for a thread summary and no session exists, summarise only the visible/current context and recommend `/lib:session start` to create a baseline.

## Capture mode

Default to `summary`. Hermes wrappers should never enable raw `log` capture by default — it's reserved for explicit operator request and routed through the safe-fallback-capture mechanism.

## Visibility (Principle 9)

Sessions default to `common` because cross-agent handover is the whole point of the layer. Before starting a `common` session, scan the surrounding Discord context for sensitivity signals:

- Identity claims about Jim or specific people
- Secrets, tokens, credentials
- Personal context (health, finances, family)
- Sensitive debugging (production incident details, customer data)

If any are present and `--private` was not supplied, **confirm with Jim before starting a `common` session**. Use `--private` to start an `agent_private` session that only the calling agent can see.

## Boundaries

- Session history is **evidence**, not durable memory. Promote selectively via `/lib:session end`'s candidates or `promote_session_fact`.
- Use `remember` / `propose_memory` for durable facts. Protected categories (identity, relationship) always route to proposals.
- Don't auto-promote anything from session content.

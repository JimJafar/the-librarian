# Harness automatic-capture capability matrix

Automatic capture (spec `2026-06-16-harness-auto-capture`, ADR 0009) feeds a
**uniform server contract** — the `POST /transcript` delta endpoint — through a
thin **per-harness acquisition adapter**. The server pipeline (buffer →
settle-sweep → extractor → curator) is built once and shared; only the small
adapter that *acquires* a per-turn delta differs per harness. This page is the
honest, seeded status of each harness (spec SC14), grounded in the §11.2
capability audit of the capture brainstorm and the §6 live test.

The three columns that decide whether a harness can capture at all:

- **Capture mechanism** — how the adapter gets a per-turn delta.
- **conv_id stability** — capture keys all per-conversation state by a stable
  conversation id (never `$USER` or `cwd`, spec §4.11). A harness without a
  stable id can't attribute deltas safely and is blocked.
- **Status** — whether Phase 1 ships it, and what gates the rest.

| Harness | Capture mechanism | conv_id stability | Status |
|---|---|---|---|
| **Claude Code** | `UserPromptSubmit` hook (primary) → tail the top-level `transcript_path` JSONL from a **byte-offset cursor** (subagents skipped; private turns skipped); `Stop` / `SessionEnd` kept as supplementary | **stable** — `session_id`; concurrent sessions write distinct `<session_id>.jsonl` files (§6) | **Authoritative**. Driven by **`UserPromptSubmit`** because Claude bug [#29767](https://github.com/anthropics/claude-code/issues/29767) means plugin-scoped `Stop` hooks register but never fire; `Stop` / `SessionEnd` stay wired so capture **auto-recovers** when the bug is fixed. Shipped in `integrations/claude/hooks/hooks.json`. |
| **Pi** | `turn_end` / `agent_end` event → completed `AgentMessage` **in-payload** (O(1), no cursor) | **stable** — `getSessionId()` | **Feasible (in-payload)** — proven floor, no spike. Adapter is a later phase (P-Pi). |
| **Hermes** | `sync_turn(user, assistant)` → both halves handed in as args **in-payload** (O(1)) | **stable** — `session_id` | **Feasible (in-payload)** — the cleanest surface, no spike. Later phase (P-Hermes). |
| **OpenCode** | `event` → `message.updated`, flush on `session.idle`; accumulate by id (avoid `session.messages()` — no cursor, O(n)) | **stable** — `sessionID` | **Feasible-with-caveats** — idle-bracketing needs a live test; the `event` hook is unwired upstream. Later phase (P-OpenCode). |
| **Codex** | `Stop` ("fires every turn"), payload unverified | **none** — `conv_id` is **cwd-keyed**; `CODEX_RUN_ID` is env-only and post-first-turn, so two convs in one cwd collide | **Blocked** — no stable per-conversation id, so a per-turn cursor can't attribute deltas. Deferred (P-Codex) pending an upstream stable id; a coarse per-cwd fallback is documented, not built. |

## Why Claude is first

Claude Code is the harness the owner uses daily, so Phase 1 builds and dogfoods
it. The §6 live test confirmed the data layer directly: the transcript is clean
append-only JSONL (so a byte-offset cursor is valid), each entry carries a stable
`sessionId`, concurrent sessions write distinct files, subagent work is isolated
in separate `subagents/*.jsonl`, and `cwd` can change *within* a session — which
is exactly why the buffer is keyed by `conv_id`, not `cwd`.

Capture is **driven by `UserPromptSubmit`**, not `Stop`. Claude bug
[#29767](https://github.com/anthropics/claude-code/issues/29767) is that
plugin-scoped `Stop` hooks register but never fire (a `SessionStart` from the same
plugin *does* fire), so a `Stop`-only adapter would silently never run.
`UserPromptSubmit` fires reliably and carries the same `session_id` +
`transcript_path`, so the adapter reads the same per-turn delta — one turn behind
(it fires just before the assistant reply), which spec §8.2 already tolerates. The
`Stop` / `SessionEnd` entries stay wired as supplementary so capture
**auto-recovers** the moment the bug is fixed; the cursor's advance-on-ack makes
multiple firing events idempotent.

## Behavior shared by every adapter

These are contract-level, not per-harness:

- **Default-on**, gated two ways (see the [slash-command / private-mode
  contract](./slash-commands.md#automatic-capture-default-on-with-two-gates)):
  the per-machine **`LIBRARIAN_AUTO_SAVE=false`** kill-switch and per-turn
  **private-mode skip** (`[librarian:private=on]`).
- **Server-authoritative intake gate.** Even with the client shipping, the
  server buffers only when its curator intake gate (`curator.intake.enabled`) is
  on; if off it refuses and buffers nothing (no raw text at rest for a dead
  pipeline). The Claude **SessionStart banner** surfaces both gate states.
- **Fail-soft.** A capture/guard/extraction error never blocks the user's turn,
  never leaks a stack trace into the model's context, and errs toward *not*
  capturing on any uncertainty.

See the [Phase-1 spec](./specs/2026-06-16-harness-auto-capture.md) for the full
success criteria and the [Claude integration README](../integrations/claude/README.md)
for the shipped hooks.

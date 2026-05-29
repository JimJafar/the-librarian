# Slash Command Contract — `/handoff`, `/takeover`, `/learn`, `/toggle-private`

This document is the source of truth for the user-facing slash commands that drive Librarian handoffs and durable memory across all supported harnesses (Hermes, Claude Code, Codex, Pi, OpenCode). Each harness's standalone plugin repo wires these up using whatever native command system the harness offers; agents that only see free-form text recognise the same surface and route to the corresponding MCP tools.

The full specification lives in [`specs/done/029-sessions-rethink-spec.md`](specs/done/029-sessions-rethink-spec.md). This file is the agent/skill-author reference.

The session subsystem this surface replaces is retired — see [`specs/done/028-sessions-rethink-plan.md`](specs/done/028-sessions-rethink-plan.md) for the rollout. Old session specs live in `specs/done/` for history.

## The four verbs

| Command | Purpose | MCP / CLI |
|---|---|---|
| `/handoff` | Store a handoff document for the next agent / harness to pick up | `store_handoff` MCP tool |
| `/takeover` | Claim the next available handoff, or a specific one by id | `claim_handoff` MCP tool |
| `/learn` | Extract durable lessons from the current conversation into memory proposals | `remember` / `propose_memory` MCP tools |
| `/toggle-private` | Toggle in-conversation off-record mode (local — no MCP call) | hook-enforced; not an MCP tool |

There is no session subsystem any more. The previous `/lib:session start|list|resume|checkpoint|pause|end|search` verbs and the dashboard's `/sessions` surface are retired in sessions-rethink PR 7.

## Parsing model

- Per-harness naming conventions follow the harness — Claude Code uses hyphenated, flat-file commands (`/handoff`, `/takeover`, `/learn`, `/toggle-private`); harnesses that support namespacing safely MAY use `:` or other separators.
- The MCP tool surface (`store_handoff`, `list_handoffs`, `claim_handoff`, plus the memory surface) is the single source of truth — whichever slash pattern a harness uses, the tools called are the same.

## `/handoff`

1. Build a handoff document covering the five required headings: **Start & intent**, **Journey**, **Current state**, **What's left**, **Open questions**. (The schema refuses documents missing any of them.)
2. Call `store_handoff` with the document plus optional project / cwd / harness scope and the in-conversation `domain`.
3. Return the new `handoff_id` so the user (or a downstream agent) can reference it.

Handoffs are domain-isolated by default and only surface inside the matching domain unless explicitly broadened.

## `/takeover`

1. With no argument: call `list_handoffs` scoped to the current domain / project / cwd, render the candidates, and let the user pick one. Never auto-select.
2. With a `hof_…` id: call `claim_handoff` directly. The claim is atomic — only one agent can claim a given handoff.
3. Inject the claimed handoff document into context and continue the work it describes.

`claim_handoff` is idempotent for the original claimer: re-claiming returns the same document, but a second agent attempting to claim the same row fails fast.

## `/learn`

1. Extract durable lessons from the current conversation — not session evidence; **memory proposals**.
2. Route protected categories (identity, relationship) through `propose_memory`; route the rest through `remember`.
3. Surface candidates to the user before persisting anything that touches identity/relationship.

There is no automatic promotion path any more — the retired `promote_session_fact` tool is gone with the rest of the session subsystem.

## `/toggle-private` (local, not an MCP tool)

`/toggle-private` toggles **off-record mode** for the current conversation. It is enforced *locally* by a synchronous path that runs before any prompt reaches the model and before any automatic Librarian call — a `UserPromptSubmit` hook (Claude Code, Codex), gateway middleware (Hermes), the `input` gate (Pi).

While private:

- The Librarian does not record evidence against the conversation.
- Automatic recall is suppressed; the user can still force a call.
- The conv-state injection block carries an explicit `[librarian:private=on]` marker so any agent reading the prompt knows the rule.

Going back on-record drops the marker on the *next* prompt; the toggle is the explicit control. Natural-language markers ("off the record", "don't remember this") are also recognised directionally.

## Boundaries

- **Handoffs are evidence, not durable memory.** They describe in-progress work and get claimed exactly once. Use `/learn` to promote a fact you want to keep into a memory proposal.
- Memory continues to live behind `recall` / `remember` / `propose_memory` / `update_memory` / `verify_memory` / `list_proposals` / `archive_memory` / `approve_proposal` — same surface as before sessions-rethink, with the legacy session tools removed.
- Visibility is set on the memory write itself; there is no longer a session-level visibility default.

# Slash Command Contract — `/handoff`, `/takeover`, `/learn`, `/toggle-private`

This document is the source of truth for the user-facing slash commands that drive Librarian handoffs and durable memory across all supported harnesses (Claude Code, Codex, OpenCode, Hermes, Pi). The harness surfaces live in-tree under [`integrations/`](../integrations) (rethink D14) and wire these up with whatever native command system the harness offers; harnesses with no command system (Codex) recognise the same surface in free-form text and route to the corresponding MCP tools.

The commands are **optional sugar** (rethink D9): the primer (`vault/primer.md`, served via the MCP `initialize` `instructions` field and `GET /primer.md`) is the canonical definition of these protocols, and the tool descriptions carry them too. Nothing is lost on a harness that only has the MCP config. Historical background: the sessions-rethink spec 029 (the session subsystem this surface replaced; completed specs live in git history) and [`adr/0007-the-rethink.md`](adr/0007-the-rethink.md) / [`specs/2026-06-12-rethink.md`](specs/2026-06-12-rethink.md) (the 7-verb consolidation).

## The four verbs

| Command | Purpose | MCP / CLI |
|---|---|---|
| `/handoff` | Store a handoff document for the next agent / harness to pick up | `store_handoff` MCP tool |
| `/takeover` | Claim the next available handoff, or a specific one by id | `list_handoffs` + `claim_handoff` MCP tools |
| `/learn` | Extract durable lessons from the current conversation into memory | `remember` MCP tool |
| `/toggle-private` | Toggle in-conversation private mode (local — no MCP call, no server state) | the `[librarian:private=on\|off]` marker; not an MCP tool |

There is no session subsystem any more. The previous `/lib:session start|list|resume|checkpoint|pause|end|search` verbs and the dashboard's `/sessions` surface are retired (sessions-rethink PR 7).

## Parsing model

- Per-harness naming conventions follow the harness — Claude Code uses hyphenated, flat-file commands (`/handoff`, `/takeover`, `/learn`, `/toggle-private`); harnesses that support namespacing safely MAY use `:` or other separators.
- The MCP tool surface (`store_handoff`, `list_handoffs`, `claim_handoff`, plus the memory surface) is the single source of truth — whichever slash pattern a harness uses, the tools called are the same.

## `/handoff`

1. Build a handoff document covering the five required headings: **Start & intent**, **Journey**, **Current state**, **What's left**, **Open questions**. (The schema refuses documents missing any of them.)
2. Call `store_handoff` with the document plus optional `project_key` / `cwd` / `harness` / `source_ref` scope.
3. Return the new `handoff_id` so the user (or a downstream agent) can reference it.

While private mode is on (see `/toggle-private`), `/handoff` requires explicit user confirmation before writing anything.

## `/takeover`

1. With no argument: call `list_handoffs` scoped to the current project / cwd (drop filters to broaden when nothing matches), render the candidates, and let the user pick one. Never auto-select.
2. With a handoff id: call `claim_handoff` directly. The claim is atomic — only one agent can claim a given handoff; a losing racer gets the existing claim back (`already_claimed`) so it can say who has it and since when.
3. Inject the claimed handoff document into context and continue the work it describes.

## `/learn`

1. Extract durable lessons from the current conversation — durable facts, validated patterns, explicit user corrections. Reject ephemera and anything grep already covers.
2. Present the candidates and let the user pick; the user picking a lesson **is** the review.
3. Call `remember` once per chosen lesson — fire-and-forget: each submission lands in the curator's intake inbox and the curator dedupes, merges, and files it asynchronously. There is no separate proposal verb (ADR 0006 retired it; `remember` subsumes it).

While private mode is on, `/learn` requires explicit user confirmation before writing anything.

## `/toggle-private` (local, not an MCP tool)

`/toggle-private` flips **in-conversation private mode** (rethink D11). It is pure in-context — no MCP call, no server flag, no hook, no on-disk state. The contract is a marker the LLM owns:

- `[librarian:private=on]` — the agent must NOT call `remember`, `store_handoff`, or `flag_memory` until told otherwise. `recall` and `search_references` stay allowed — but those read queries reach the Librarian server's logs; the agent says so if asked.
- `[librarian:private=off]` — normal operation.
- **Default when no marker is present:** OFF.

Natural-language phrases ("go private", "off the record", "don't remember this") are recognised directionally — the primer teaches the same contract.

Known limitation: if the harness compacts the conversation and drops the marker, the agent defaults back to OFF. Operators who need hard guarantees should avoid compaction during a private stretch.

## Boundaries

- **Handoffs are evidence, not durable memory.** They describe in-progress work and get claimed exactly once. Use `/learn` to promote a fact you want to keep into durable memory.
- The agent-facing memory surface is `recall` / `remember` / `flag_memory` (plus `search_references` for long-form background). `remember` is fire-and-forget into the curator's intake inbox; `flag_memory` routes a quality concern to review. Admin/curatorial ops (archive, approve, update, list-proposals) are **not** on the agent MCP — they live on the dashboard tRPC surface.

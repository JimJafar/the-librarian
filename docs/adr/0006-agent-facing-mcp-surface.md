# ADR 0006 — The agent-facing MCP surface (slim to 9 verbs)

- **Status:** Proposed (under review — not yet implemented)
- **Date:** 2026-06-11
- **Context:** The MCP tool surface grew to 19 verbs mixing agent, admin, and redundant tools; the plugins describe them inconsistently.

## Context

The MCP server exposes **19 tools**. Auditing them against "what does an
*agent* actually need" surfaced three problems:

1. **Redundancy.** `propose_memory` is now a special case of `remember` (both
   route through the curator inbox; the curator proposes protected categories
   on its own — see ADR 0004). `archive_memory` duplicates
   `verify_memory result=outdated`. `start_context` overlaps the per-session
   injected primer.
2. **Non-agent verbs on the agent surface.** `archive_memory`,
   `approve_proposal`, `list_proposals`, and `update_memory` are
   admin/dashboard/curation operations, not things an agent reasons with. The
   dashboard already drives those over **tRPC**; exposing them as agent MCP
   tools is duplicate surface.
3. **A real bug masquerading as design.** `start_context` returns the entire
   set of active `is_global` memories with **no limit** (other sections cap at
   6/8), so it returned ~150 KB for a heavy global corpus.

The plugins then describe this surface inconsistently — different tool names,
some referencing retired verbs — because the surface is too large and too
muddled to teach reliably. The fix is to make the surface **small enough that
the injected primer plus the tools' own descriptions are sufficient** for an
agent to use it well (no bundled "how to use The Librarian" skill needed).

## Decision

### The agent-facing MCP is exactly **9 verbs**

| Group | Verb | Purpose |
|---|---|---|
| Memory | `recall` | Search memory by query/tags |
| | `remember` | Save a durable memory |
| | `flag_memory` | Flag a memory as wrong/misleading/outdated (see below) |
| Handoffs | `store_handoff` | Persist a handoff document |
| | `list_handoffs` | List unclaimed handoffs visible to the caller |
| | `claim_handoff` | Atomically claim a handoff |
| Lookups | `list_skills` | List server-hosted skills (`slug`, `name`, `description`) |
| | `get_skill` | Fetch one skill's full document by slug |
| | `search_references` | Search the reference-doc corpus |

Everything else is removed from the agent surface, replaced, or relocated.

### Removed (9)

- `start_context` — the **injected primer** (editable, per-session) covers task
  bootstrap with more control; agents `recall` on demand instead of receiving a
  dump. (Also fixes the unbounded 150 KB return.)
- `propose_memory` — subsumed by `remember` (ADR 0004 routing already funnels
  both through the inbox; protected categories propose automatically).
- `archive_memory`, `approve_proposal`, `list_proposals`, `update_memory` — not
  agent verbs. Admin/curation/review work goes via **tRPC** (the dashboard
  already uses `memories.archive` / `approve` / `list(status=proposed)` /
  `update`) or **in-process** (the curator). The MCP simply stops exposing them
  to agents; no capability is lost.
- `find_skills` — ranked skill search is overkill for a small catalog;
  `list_skills` + the model's own judgment replaces it. (Re-introducible later
  if the catalog grows large.)
- `session_manifest` → replaced by `list_skills` (below).
- `verify_memory` → replaced by `flag_memory` (below).

### `verify_memory` → `flag_memory(memory_id, reason)`

`verify_memory(useful|not_useful|outdated)` had two flaws: a **positive signal
that's gameable and ambiguous** ("useful" conflated with "relevant to this
search"), and an **agent-driven unilateral archive** (`outdated` archived the
memory outright). Both go.

- **New verb:** `flag_memory(memory_id: string, reason: string)` — free-text
  `reason` ("incorrect", "misleading", "outdated", "superseded by X", …).
- **Optional, not compulsory.** Agents flag only when they have a genuine
  quality concern. There is intentionally **no signal for "this memory was
  correct" or "irrelevant to my search"** — those aren't quality judgements and
  shouldn't move anything.
- **Route to review, don't delete.** A flag records `{memory_id, agent_id,
  reason, created_at}` and surfaces it for adjudication — in the dashboard and
  as **input to the curator's grooming pass**, which (with a human, or the
  curator) decides to correct, supersede, archive, or dismiss. One agent's flag
  never destroys a memory.
- **No positive signal.** Recall ranking leans on the **passive** signals it
  already has — `recall_count` (incremented on every recall), recency, and the
  memory's own `priority` / `confidence` — not on agents voting "useful".
- **Open sub-decision (recommend yes):** a flagged memory is also **soft-
  demoted** in recall until adjudicated, so demonstrably-wrong info stops
  dominating recall immediately without being hard-deleted.

### `session_manifest` → `list_skills()`

`session_manifest` returned `{ workingStyle, skills }`. Split it:

- **`list_skills()`** returns just `[{ slug, name, description }]` from the
  server-hosted catalog (`store.skills.listSkills()`); `get_skill(slug)` fetches
  the full doc on demand (unchanged).
- The **working-style preamble moves into the injected primer**, where editable
  per-session guidance belongs.

### `conv_state_*` is relocated **off** the agent tool surface

`conv_state_get` / `upsert` / `clear` are the plumbing the per-turn injection
hook uses to read/maintain the primer + domain state. **An agent never reasons
with them** — so by the same rule that removes the admin verbs, they don't
belong in the agent's tool list. They move to a **private injection channel**
(a dedicated endpoint or an internal MCP not surfaced via `tools/list`) that the
hook calls. Primer injection is functionally unchanged; it just stops appearing
to the model as three callable tools.

### Discovery is the protocol's job — no `list_verbs`

MCP's native **`tools/list`** already hands the harness every tool's name,
description, and input schema, which the harness presents to the model each
turn. A `list_verbs` tool would duplicate the protocol (and list itself). So:

- **Tool `description`s are the agent's reference** — they must be tight and
  behavioural (this is now their primary documentation).
- **The primer is the operating manual** — *when/why* to recall vs. remember,
  flag-don't-archive, no "verify as correct", don't over-record — naming verbs
  where doctrine ties to a tool, never re-listing the catalog.

### No bundled, auto-loaded skill in any plugin

No plugin ships a "how to use The Librarian" skill. The 9-verb surface + the
injected primer + the per-verb descriptions are the teaching surface. (This is
why the surface must stay small and self-describing.)

## Consequences

**Positive**

- The agent sees **9 focused, self-describing verbs** instead of 19 — easier to
  use correctly, easier to teach via one primer, consistent across harnesses.
- Clean separation of concerns: **agents** use the MCP; **dashboard/admin** uses
  tRPC; **curator** runs in-process; **injection** uses a private channel.
- `flag_memory` replaces unilateral agent archival with route-to-review, fitting
  the "agents propose/flag, curator+human dispose" model.
- The 150 KB `start_context` problem disappears with the verb.

**Negative / trade-offs**

- **Breaking change to the MCP tool contract** (a sacred cross-repo contract).
  Every plugin's session hook and slash-command wiring that calls a removed verb
  must change in lockstep — coordinated release, monorepo first.
- **Loss of the agent-driven fast archive.** `verify_memory(outdated)` archived
  immediately; `flag_memory` only routes to review. The soft-demote sub-decision
  mitigates the "wrong memory keeps surfacing" gap; full removal still waits on
  the curator/human.
- **`flag_memory` needs new machinery** — flag storage + a dashboard surface +
  curator consumption. It's more than a rename.

## Migration / sequencing

1. **Monorepo first** — implement the 9-verb surface: add `flag_memory` +
   `list_skills`, remove the 9 retired tools, relocate `conv_state_*` to the
   injection channel, sharpen the surviving descriptions, fold working-style
   into the primer. Verify the removed admin verbs already have tRPC equivalents
   (they do).
2. **Then each plugin** — remove the bundled skill, update the session hook +
   slash-command wiring to the new surface, refresh the primer. Same coordinated
   MINOR across the family (pre-1.0, breaking-with-`### Removed`-notes).

## Open decisions (for review before implementation)

1. **`flag_memory` soft-demote** — include the recall demotion while a flag is
   open, or pure route-to-review? *(Recommend: include.)*
2. **`conv_state_*` relocation timing** — move off the agent surface in this
   change, or keep as tools for an interim while the injection channel lands?
   *(Recommend: the relocation is the end-state; sequence as feasible.)*
3. **Skills vs. references** — keep `list_skills`/`get_skill` and
   `search_references` as two lookup surfaces, or unify into one? *(Recommend:
   keep split — different corpora.)*
4. **Skill catalog reality check** — confirm the server actually hosts skills
   today; if the catalog is empty in practice, `list_skills`/`get_skill` are a
   capability ahead of content (still fine to keep, but worth knowing).

## Related

- ADR 0004 — `propose_memory` routes through the inbox. **Partly superseded:**
  this ADR removes `propose_memory` entirely; its inbox-routing rationale now
  lives only on `remember`.
- Retired verbs from this change: `start_context`, `propose_memory`,
  `archive_memory`, `approve_proposal`, `list_proposals`, `update_memory`,
  `find_skills`, `session_manifest`, `verify_memory`.

# Plan: Memory Domain Isolation & Conversation State

Companion to [`memory-domain-isolation-and-conv-state.md`](./memory-domain-isolation-and-conv-state.md). The spec defines **what** and **why**; this plan defines **how**, in what **order**, what's parallelisable, what the **risks** are, and how each phase is **verified**.

## Status

Drafted 2026-05-27. Not started.

---

## Component dependency graph

```
                ┌──────────────────────────┐
                │  PR 1 — Additive schema  │
                │  new columns + tables,   │
                │  legacy-derived booleans │
                │  + backfill script       │
                └────────────┬─────────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
   ┌──────────▼───────────┐     ┌───────────▼──────────┐
   │ PR 2 — conv_state    │     │ PR 4 — Dashboard     │
   │ store + MCP tools +  │     │ surface (can start   │
   │ hook helpers         │     │ as soon as schema is │
   └──────────┬───────────┘     │ live; deeper work    │
              │                 │ blocked on PR 2/3)   │
              │                 └───────────┬──────────┘
              │                             │
   ┌──────────▼───────────┐                 │
   │ PR 3 — Domain        │                 │
   │ enforcement in       │                 │
   │ remember/recall/     │                 │
   │ start_session/resume │                 │
   └──────────┬───────────┘                 │
              │                             │
              ├─────────────────────────────┘
              │
   ┌──────────▼───────────┐    ┌──────────────────────┐
   │ PR 5 — Harness       │    │ PR 6 — Classifier in │
   │ integrations         │    │ shadow mode (can     │
   │ (Claude, Hermes,     │    │ run in parallel with │
   │ CLI) — sibling repos │    │ PR 5; independent)   │
   └──────────┬───────────┘    └───────────┬──────────┘
              │                            │
              └──────────────┬─────────────┘
                             │
                ┌────────────▼─────────────┐
                │ PR 7 — Classifier        │
                │ cutover. Drop category/  │
                │ visibility/scope columns │
                └────────────┬─────────────┘
                             │
                ┌────────────▼─────────────┐
                │ PR 8 — Documentation     │
                │ (can start in P5/P6;     │
                │ finalised after P7)      │
                └──────────────────────────┘
```

Pre-work (off-graph but must land before PR 6): **`classifier-implementation-spec.md`** — defines the model choice, serving topology, prompt-versioning workflow, eval-harness shape. See §9 of the main spec.

---

## Execution mode

**Solo, serial.** One PR in flight at a time, walking the critical path. The parallelisation map below is retained as a reference for the case where a second agent joins; it does not drive day-to-day execution.

---

## What could run in parallel (reference only)

| Pair / set | Parallelisable? | Reason |
|---|---|---|
| PR 1 + anything | **No.** Hard prerequisite. | Every other PR reads or writes the new columns/tables. |
| PR 2 + PR 4 (early) | **Yes, partly.** | T4.1 (`/domains` page) is pure CRUD against the `domains` table from PR 1 — no dependency on conv_state. Deeper PR 4 work (proposal modal, detail-panel toggles) is independent of PR 2 too. The cross-cut is the `<conversation-state>` rendering surface, which is one helper used by PR 5 hooks, not the dashboard. |
| PR 2 vs PR 3 | **Sequential.** | PR 3 imports the conv_state store and tools from PR 2. |
| PR 3 + PR 4 | **Yes.** | Dashboard and server tools are independent consumers of the schema. Can land in either order. |
| PR 5 + PR 6 | **Yes.** | Harness integrations and the classifier are fully independent. Different repos, different teams' attention if any. |
| PR 5 sibling repos (Claude, Hermes, CLI) | **Yes.** | Each is its own repo and its own PR. |
| PR 6 vs PR 7 | **Sequential, with validation window.** | PR 7 cannot land until shadow-mode telemetry from PR 6 shows acceptable classifier quality. Allow a deliberate week+ of shadow operation before PR 7. |
| PR 8 | **Throughout.** | Doc updates land as each PR ships. Final pass after PR 7. |

---

## Phase 1 — Additive schema (PR 1)

Land all new tables and columns; keep all old columns. Existing reads/writes continue to work. Booleans are derived from category via legacy logic so the rest of the system can start consuming them.

### Tasks

#### T1.1 — Add new tables to projection

**Description:** Create `conversation_state`, `domains`, `signal_rules`, `token_domain_bindings` tables in the SQLite projection. Seed `domains` with one row (`general`).

**Acceptance criteria:**
- [ ] All four tables exist after mcp-server startup against a fresh database
- [ ] `domains` contains one row (`name = 'general'`) after startup
- [ ] Re-running startup is idempotent (no duplicate seeds, no errors)

**Verification:**
- [ ] Unit test in `packages/core/test/projection.test.ts` verifying table creation and seed
- [ ] `pnpm test --filter @librarian/core`

**Files likely touched:**
- `packages/core/src/store/projection.ts`
- `packages/core/test/projection.test.ts`

**Scope:** S

**Dependencies:** none.

#### T1.2 — Add new columns to `memories` and `sessions`

**Description:** Add `domain`, `is_global`, `requires_approval` to `memories` and `domain` to `sessions`. Defaults match spec §7.1.

**Acceptance criteria:**
- [ ] `memories` rows get `domain='general', is_global=0, requires_approval=0` by default
- [ ] `sessions` rows get `domain='general'` by default
- [ ] Legacy `category`, `visibility`, `scope` columns are untouched
- [ ] Existing `INSERT`s without the new columns succeed (defaults apply)

**Verification:**
- [ ] Unit test exercising INSERT with and without the new columns
- [ ] `pnpm test --filter @librarian/core`

**Files likely touched:**
- `packages/core/src/store/projection.ts`
- `packages/core/src/schemas/memory.ts`
- `packages/core/src/schemas/session.ts`
- corresponding tests

**Scope:** S

**Dependencies:** T1.1.

#### T1.3 — Derive booleans from category (legacy bridge)

**Description:** Update `normalizeMemoryInput` and the projection handler for `memory.created` to derive `is_global` and `requires_approval` from the existing `category` value. This bridges the gap until the classifier ships.

Derivation rules (from spec §7.2):
- `identity | relationship` → `requires_approval = 1`
- `identity | relationship | preferences` → `is_global = 1`
- everything else → both `0`

**Acceptance criteria:**
- [ ] A new memory created with `category='identity'` lands with `requires_approval=1, is_global=1`
- [ ] A new memory created with `category='preferences'` lands with `requires_approval=0, is_global=1`
- [ ] A new memory created with `category='tools'` lands with `requires_approval=0, is_global=0`
- [ ] Existing `PROTECTED_CATEGORIES`-driven proposal routing keeps working (i.e. category-derived `requires_approval` triggers the proposal flow)

**Verification:**
- [ ] Unit tests covering each derivation rule
- [ ] Integration test: write an `identity` memory via the existing `propose_memory` flow; confirm `status='proposed'` and `requires_approval=1`
- [ ] `pnpm test --filter @librarian/core`

**Files likely touched:**
- `packages/core/src/constants.ts` (`normalizeMemoryInput`)
- `packages/core/src/store/memory-store.ts` (`createMemory` — read derived value)
- `packages/core/src/store/projection.ts` (projection of `memory.created`)
- corresponding tests

**Scope:** M

**Dependencies:** T1.2.

#### T1.4 — Migration script: backfill historical projection

**Description:** New script `scripts/migrate-add-domain-and-conv-state.mjs`. Reads `events.jsonl` and `sessions.jsonl`, populates the new columns on every historical row in the projection. Idempotent.

Migration rules per spec §7.2:
- Convert the original category value to a tag (deduped). For `identity`/`relationship`, also add the tag `profile`.
- Derive `requires_approval` and `is_global` from original category.
- Assign `domain = 'legacy-private'` if original `visibility = 'agent_private'`; else `'general'`.
- Auto-create the `legacy-private` domain if at least one memory needs it.
- For sessions: assign `domain = 'general'`.

**Acceptance criteria:**
- [ ] Running on a snapshot of production-shape data produces the expected column values per the rules above
- [ ] Running the script twice produces identical projection state
- [ ] The script logs counts: memories backfilled, sessions backfilled, `legacy-private` memories migrated
- [ ] No new events are appended to `events.jsonl` or `sessions.jsonl`
- [ ] Existing recall behaviour is unchanged for non-private memories (`domain='general'` matches the single-domain default filter)

**Verification:**
- [ ] Unit test with a fixture JSONL covering all derivation branches
- [ ] Idempotency test: run twice, assert identical state
- [ ] Smoke test: run against a copy of the canonical instance's data; manually inspect 10 random memories

**Files likely touched:**
- `scripts/migrate-add-domain-and-conv-state.mjs`
- `test/migrate-add-domain-and-conv-state.test.mjs`

**Scope:** M

**Dependencies:** T1.2, T1.3.

#### T1.5 — Releasability gate for PR 1

**Description:** Final integration tests proving PR 1 leaves `main` releasable — agents writing and recalling memories with the existing tool surface see no behaviour change.

**Acceptance criteria:**
- [ ] All existing tests pass
- [ ] `remember` followed by `recall` returns the memory (single-domain default, no conv_state, all memories share `domain='general'`)
- [ ] `propose_memory` with `category='identity'` lands as `proposed`

**Verification:**
- [ ] Full repo test suite green: `pnpm test`
- [ ] Manual integration check against a local mcp-server

**Files likely touched:** none new — this is a verification task.

**Scope:** XS

**Dependencies:** T1.1–T1.4.

### Phase 1 risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Schema migration on production database fails partway through | low | high | Take a JSONL backup before running the migration. Script is idempotent — failed runs can be retried after fixing the root cause. |
| Derivation logic mismatches existing PROTECTED_CATEGORIES routing | medium | high | T1.3 acceptance criterion explicitly covers this. Add a regression test for an identity memory landing in `status='proposed'`. |
| Backfill rule for `agent_private` → `legacy-private` surfaces formerly-hidden content | low | high | The whole point of the `legacy-private` domain is to *not* mix this content into `general`. T1.4 acceptance criterion covers this. PR 4 will add the dashboard prompt to review the domain. |
| `requires_approval` flag on existing active memories retroactively re-routes them to the proposal queue | low | medium | The flag is metadata only on existing rows — only NEW memories check `requires_approval` to determine initial `status`. T1.3 must verify existing active rows are not affected. |

### Checkpoint: end of Phase 1

- [ ] All Phase 1 tasks merged
- [ ] Full test suite passing on `main`
- [ ] Migration script run against the canonical instance; backup confirmed
- [ ] Manual review: pick 10 random pre-migration memories and verify their new column values look right
- [ ] Reviewed with Jim before starting Phase 2

---

## Phase 2 — conv_state registry + MCP tools + hook helpers (PR 2)

Build the server-side machinery that PR 3 and PR 5 will consume. No user-visible behaviour change.

### Tasks

#### T2.1 — `conversation-state-store.ts` module

**Description:** New module in `@librarian/core` exposing `get(conv_id)`, `upsert(conv_id, patch)`, `clear(conv_id)`. Backed by the `conversation_state` table from T1.1.

**Acceptance criteria:**
- [ ] `get` returns the row or `null`
- [ ] `upsert` creates or updates; bumps `updated_at`
- [ ] `clear` deletes the row
- [ ] All operations are atomic per call

**Verification:**
- [ ] Unit tests in `packages/core/test/store/conversation-state-store.test.ts`
- [ ] `pnpm test --filter @librarian/core`

**Files likely touched:**
- `packages/core/src/store/conversation-state-store.ts`
- `packages/core/src/schemas/conversation-state.ts`
- corresponding test

**Scope:** S

**Dependencies:** PR 1.

#### T2.2 — MCP tools for conv_state

**Description:** Three new MCP tools: `conv_state.get`, `conv_state.upsert`, `conv_state.clear`. Available to agents (no admin gate — the conversation owns its own state).

**Acceptance criteria:**
- [ ] Tools register in dispatch and are listed by `tools/list`
- [ ] Input schemas validate `conv_id` as required
- [ ] Each tool calls into the T2.1 store
- [ ] Returns documented MCP shapes

**Verification:**
- [ ] Unit tests per tool in `packages/mcp-server/test/mcp/tools/`
- [ ] End-to-end test: call `conv_state.upsert` then `conv_state.get`, assert round-trip

**Files likely touched:**
- `packages/mcp-server/src/mcp/tools/conv-state-get.ts`
- `packages/mcp-server/src/mcp/tools/conv-state-upsert.ts`
- `packages/mcp-server/src/mcp/tools/conv-state-clear.ts`
- `packages/mcp-server/src/mcp/dispatch.ts` (register)
- corresponding tests

**Scope:** S

**Dependencies:** T2.1.

#### T2.3 — Hook-injection helper

**Description:** Pure function `renderConvStateBlock(state: ConversationState | null): string`. Returns the `<conversation-state>...</conversation-state>` block from spec §4.9, or empty string for `null`. Used by PR 5 hook implementations across harnesses; lives in `@librarian/core` so all integrations share one canonical format.

**Acceptance criteria:**
- [ ] Format matches §4.9 exactly (whitespace, key order, field names)
- [ ] Handles missing `session_id` (renders `none`)
- [ ] Handles `off_record=true` and `off_record=false`
- [ ] Returns empty string for `null` input (no state, no block)

**Verification:**
- [ ] Snapshot test against the exact expected format
- [ ] `pnpm test --filter @librarian/core`

**Files likely touched:**
- `packages/core/src/conv-state-render.ts`
- corresponding test

**Scope:** XS

**Dependencies:** T2.1.

#### T2.4 — Releasability gate for PR 2

**Acceptance criteria:**
- [ ] All existing tests pass
- [ ] New conv_state tools callable via MCP
- [ ] No behavioural changes for memory write/read

**Scope:** XS

**Dependencies:** T2.1–T2.3.

### Phase 2 risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `conv_id` collision across harnesses (Claude Code and Hermes both produce the same string) | low | high | Prefix in PR 5 hook implementations: `claude:<id>`, `hermes:<channel>:<thread>`. Treat this as a convention, not a server-side check. |
| MCP tool surface for conv_state encourages agents to manipulate their own state | medium | medium | Document in PR 8 that agents should not call `conv_state.upsert` directly; this is for hook code. No server-side enforcement in V1, but worth flagging. |
| Snapshot test on the hook-injection block locks in a format that turns out to be wrong | low | low | Re-snapshot is cheap. Treat the test as "this is the format" not "this is the truth". |

### Checkpoint: end of Phase 2

- [ ] All Phase 2 tasks merged
- [ ] Full test suite green
- [ ] `conv_state.upsert` + `conv_state.get` round-trips against a running mcp-server
- [ ] Reviewed with Jim before starting Phase 3

---

## Phase 3 — Domain enforcement in remember/recall/sessions (PR 3)

The first phase where the new model actually changes behaviour. Domain filtering activates. Server-side `domain` assignment activates. Single-domain installs see no change (the special case in §4.10).

### Tasks

#### T3.1 — `remember` reads conv_state, server-sets `domain`

**Description:** Update the `remember` tool handler to look up `conv_state` via the new MCP context (the harness should pass `conv_id`). Server-set `domain` from `conv_state.domain`. Strip any caller-supplied `domain`, `is_global`, `requires_approval` from the input (ignore silently in V1; log a warning).

**Acceptance criteria:**
- [ ] If `conv_id` is in context and `conv_state` exists: memory gets `domain = conv_state.domain`
- [ ] If no `conv_id` or no `conv_state`: memory enters the proposal queue per §4.14 (`domain = NULL`, `requires_approval = true`)
- [ ] Caller-supplied `domain` / `is_global` / `requires_approval` are ignored

**Verification:**
- [ ] Unit tests covering all three branches above
- [ ] Integration test: upsert conv_state with `domain='coding'`, call `remember`, recall and verify the memory tag

**Files likely touched:**
- `packages/mcp-server/src/mcp/tools/remember.ts`
- `packages/mcp-server/src/mcp/tools/schemas.ts` (remove the now-ignored fields from `memoryInputSchema()`)
- corresponding tests

**Scope:** M

**Dependencies:** PR 2.

#### T3.2 — `recall` applies domain hard filter; new `tags` and `include_other_domains` inputs

**Description:** Update `recall` handler per spec §4.11. Apply `WHERE (domain = :current_domain OR is_global = 1) AND status = 'active'` against the projection. Remove `categories` and `include_private` from the input schema; add `tags` and `include_other_domains`. Admin callers bypass the domain filter.

**Acceptance criteria:**
- [ ] In a `coding` conv_state, `recall` returns only memories with `domain='coding'` or `is_global=1`
- [ ] `include_other_domains: true` returns all domains
- [ ] `tags: ['react']` filters to memories carrying that tag
- [ ] Admin role (no `conv_id`) sees all memories
- [ ] No conv_state, no `include_other_domains`: returns only globals (defensive — agents without context should not see arbitrary content)

**Verification:**
- [ ] Comprehensive filter test matrix in `packages/mcp-server/test/mcp/tools/recall.test.ts`
- [ ] Integration test against seeded projection

**Files likely touched:**
- `packages/mcp-server/src/mcp/tools/recall.ts`
- `packages/core/src/store/memory-store.ts` (`searchMemories`)
- corresponding tests

**Scope:** M

**Dependencies:** T3.1.

#### T3.3 — `start_session` inherits domain; resume seeds conv_state

**Description:** Update `start_session` to read `conv_state.domain` and persist it on the session row. Update the `/lib-session-resume` flow to write `domain = session.domain` into the resuming conv_state (overwriting any existing value per D10).

**Acceptance criteria:**
- [ ] `start_session` called from a `domain='coding'` conv_state produces a session with `domain='coding'`
- [ ] `start_session` called without a conv_state defaults to `domain='general'`
- [ ] `lib-session-resume` of a `domain='coding'` session into a fresh conv_id sets `conv_state.domain='coding'`
- [ ] Signal-precedence chain (PR 5 work) is bypassed on resume — verified by integration test passing `domain=coding` through resume with no signal rules configured

**Verification:**
- [ ] Unit tests for the start_session inheritance
- [ ] Unit + integration tests for the resume seeding
- [ ] `pnpm test --filter @librarian/mcp-server`

**Files likely touched:**
- `packages/mcp-server/src/mcp/tools/start-session.ts`
- `packages/mcp-server/src/mcp/tools/resume-session.ts` (or wherever `lib-session-resume` lives)
- `packages/core/src/store/session-store.ts`
- corresponding tests

**Scope:** M

**Dependencies:** T3.1, T3.2.

#### T3.4 — `listMemories` (dashboard read path) honours new filters

**Description:** Update `listMemories` to filter by `domain`, `is_global`, `requires_approval`, and `tags`. Remove `category`-based filtering. Keep the existing `agent_id` and `status` filters.

**Acceptance criteria:**
- [ ] Dashboard list filtering by `domain='coding'` returns only those memories
- [ ] Dashboard filter "Pending approval" returns `requires_approval=1` AND `status='proposed'`
- [ ] Existing tests for the older filter shape are updated, not skipped

**Verification:**
- [ ] Unit tests for each new filter axis
- [ ] `pnpm test --filter @librarian/core`

**Files likely touched:**
- `packages/core/src/store/memory-store.ts` (`listMemories`)
- corresponding tests

**Scope:** S

**Dependencies:** T3.1.

#### T3.5 — Releasability gate for PR 3

**Acceptance criteria:**
- [ ] All existing tests pass
- [ ] Manual: upsert conv_state to `domain='coding'`; call `remember` with a coding-related fact; call `recall` and confirm presence; switch conv_state to `domain='family-admin'`; recall the same query and confirm absence
- [ ] Single-domain install (only `general` exists): behaviour unchanged from PR 1

**Scope:** XS

**Dependencies:** T3.1–T3.4.

### Phase 3 risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Without PR 5 (harness integrations), there's no `conv_id` in context — `remember` always falls to the outside-session branch | high | medium | Expected during transition. Manual conv_state upsert via the new MCP tool is the workaround until PR 5 lands. Document this in the PR description. |
| Cross-harness resume overwrites a fresh conv_state's `domain` and surprises the user | low | medium | Document explicitly in the dashboard's resume confirmation. Out of scope for PR 3 itself but worth flagging for PR 4. |
| Removing `categories` from `recall` breaks any external caller still passing it | low | low | We control all known callers (Claude Code plugin, Hermes plugin, CLI). The MCP server can log-and-ignore unknown inputs rather than rejecting. |
| Admin filter bypass is implemented as "no `conv_id`" but admins might legitimately have one | low | medium | The bypass is keyed off `role === 'admin'` from ToolContext, not off `conv_id` absence. T3.2 acceptance criterion explicitly covers this. |

### Checkpoint: end of Phase 3

- [ ] All Phase 3 tasks merged
- [ ] Full test suite green
- [ ] Manual cross-domain demo working (see T3.5 acceptance)
- [ ] Reviewed with Jim before starting Phase 4

---

## Phase 4 — Dashboard surface (PR 4)

User-facing controls. Can begin as soon as PR 1 lands (the schema is in place); proposal-modal work depends on PR 3 routing semantics.

### Tasks

#### T4.1 — `/domains` page

**Description:** New Next.js page at `apps/dashboard/app/(memories)/domains/page.tsx`. Flat list of domains. Add/remove/rename. Removing a domain that has memories warns and requires confirmation (memories revert to `general`).

**Acceptance criteria:**
- [ ] List shows all rows from `domains` table
- [ ] Add form creates a new row
- [ ] Remove confirms; on confirm, deletes the domain and reassigns its memories to `general`
- [ ] Cannot remove `general` (the floor)

**Verification:**
- [ ] Component + server-action unit tests
- [ ] e2e Playwright test for the add/remove flow

**Files likely touched:**
- `apps/dashboard/app/(memories)/domains/page.tsx`
- `apps/dashboard/app/(memories)/domains/actions.ts`
- `apps/dashboard/components/domains/domain-list.tsx`
- e2e: `apps/dashboard/e2e/domains.spec.ts`

**Scope:** M

**Dependencies:** PR 1 (schema only).

#### T4.2 — `/signal-rules` page

**Description:** New page combining the two signal-precedence sources from §4.10: harness-pattern rules (signal_rules table) and token-bound defaults (token_domain_bindings table). CRUD on both.

**Acceptance criteria:**
- [ ] List shows all rules grouped by harness
- [ ] Add form creates a rule with `{harness, pattern, domain, priority}`
- [ ] List shows token bindings; add form creates `{token_id, domain}`
- [ ] Remove on either
- [ ] Validation: domain must exist in `domains` table

**Verification:**
- [ ] Component + server-action unit tests
- [ ] e2e test for the add flow on both rule types

**Files likely touched:**
- `apps/dashboard/app/(memories)/signal-rules/page.tsx` and supporting components
- corresponding actions

**Scope:** M

**Dependencies:** T4.1 (validation depends on the domains list).

#### T4.3 — Proposal-approval modal with domain picker

**Description:** Update `components/memories/proposals-view.tsx` per spec §4.14. If `proposal.domain` is set: Approve is one-click. If `NULL`: Approve opens a modal with a domain picker; submit applies the domain and approves.

**Acceptance criteria:**
- [ ] Proposals with set domain: existing one-click flow unchanged
- [ ] Proposals with `NULL` domain: Approve button opens modal
- [ ] Modal lists all domains from `domains` table
- [ ] Modal submit calls `updateMemoryAction` to set the domain, then `approveProposalAction`
- [ ] Cancel closes modal without changes

**Verification:**
- [ ] Component test for modal open/close
- [ ] e2e test exercising both paths (set-domain vs NULL-domain)

**Files likely touched:**
- `apps/dashboard/components/memories/proposals-view.tsx`
- new `apps/dashboard/components/memories/approve-modal.tsx`
- corresponding tests

**Scope:** M

**Dependencies:** PR 3 (routing creates the NULL-domain proposals).

#### T4.4 — Memory detail panel: domain + boolean toggles

**Description:** Update `components/memories/detail-panel.tsx` (which already supports edit) to surface and edit `domain`, `is_global`, `requires_approval`. Booleans render as toggles; domain as a dropdown sourced from `domains`. Saving emits `memory.classification_overridden` per D19.

**Acceptance criteria:**
- [ ] Domain dropdown lists all domains
- [ ] Toggles for the two booleans
- [ ] Save persists via `updateMemoryAction`
- [ ] When either boolean is overridden, the event ledger gets `memory.classification_overridden`

**Verification:**
- [ ] Component test
- [ ] Integration test: toggle, save, assert event in ledger

**Files likely touched:**
- `apps/dashboard/components/memories/detail-panel.tsx`
- `packages/core/src/store/memory-store.ts` (record override event)
- corresponding tests

**Scope:** M

**Dependencies:** PR 1.

#### T4.5 — Replace category-grouped views with tag/domain/boolean filters

**Description:** Audit existing dashboard views that group or filter by `category`. Replace with the new axes: domain, tags, `is_global`, `requires_approval`. Sidebar nav reflects the change.

**Acceptance criteria:**
- [ ] No remaining UI references to `category`
- [ ] New filter UI shows: domain selector, tag multi-select, "Global only" toggle, "Pending approval" toggle
- [ ] List shows the chosen axis values per row

**Verification:**
- [ ] e2e test exercising each new filter
- [ ] Manual: visually compare before/after on the staging dashboard

**Files likely touched:**
- `apps/dashboard/components/memories/simple-list.tsx`
- `apps/dashboard/components/memories/filters.tsx` (if it exists; otherwise the page-level filter UI)
- `apps/dashboard/app/(memories)/page.tsx`
- corresponding tests

**Scope:** M

**Dependencies:** T4.1, T4.4.

#### T4.6 — Releasability gate for PR 4

**Acceptance criteria:**
- [ ] All dashboard tests pass
- [ ] e2e suite green
- [ ] Manual walk-through of: create domain → create signal rule → trigger a proposal via outside-session write → approve via modal → see in domain-filtered list

**Scope:** XS

**Dependencies:** T4.1–T4.5.

### Phase 4 risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Removing a domain with assigned memories is destructive | medium | high | T4.1 explicit confirmation; reassign to `general` rather than delete the memories. Disallow removal of `general` and `legacy-private` (the latter has owner-review semantics). |
| Override event emission ties dashboard writes to the ledger format | low | medium | Tested in T4.4. The event schema is owned by `@librarian/core` and versioned alongside other ledger events. |
| Dashboard PR is too large (5 sub-tasks each medium-sized) | high | medium | Split into 2-3 sub-PRs if any one task balloons. T4.1+T4.2 together; T4.3 alone; T4.4+T4.5 together. |

### Checkpoint: end of Phase 4

- [ ] All Phase 4 tasks merged (possibly as 2-3 sub-PRs)
- [ ] e2e suite green
- [ ] Manual walk-through complete
- [ ] Reviewed with Jim before starting Phase 5

---

## Phase 5 — Harness integrations (PR 5, sibling repos)

Each integration is its own PR in its own repo. **None of these can land before PR 2 (conv_state tools)**. The Claude Code plugin and Hermes plugin are independent of each other.

### Tasks

#### T5.1 — Claude Code plugin: hook + session-start prompt

**Repo:** sibling `the-librarian-claude-plugin` (per the existing structure).

**Description:** Implement the per-turn hook contract from §4.9 using `UserPromptSubmit`. Reads `CLAUDE_SESSION_ID` as `conv_id` (prefixed `claude:`). Fetches `conv_state`, injects via `renderConvStateBlock` (from T2.3). On new conversation (no conv_state), runs the signal-precedence chain from §4.10.

**Acceptance criteria:**
- [ ] Every user prompt in a Claude Code session triggers the hook
- [ ] First-turn behaviour: signal-precedence chain runs; for single-domain installs, no prompt
- [ ] Subsequent turns: state is re-injected from the registry
- [ ] After context compaction, the next turn still has the correct domain in the injected block

**Verification:**
- [ ] Manual test against a real Claude Code session
- [ ] Unit tests for the precedence-chain logic
- [ ] Long-conversation test: force compaction, verify state survives

**Files likely touched (sibling repo):**
- Plugin entry point (existing)
- New hook handler module
- Tests

**Scope:** L (in its own repo, this is a feature)

**Dependencies:** PR 2 (conv_state tools).

#### T5.2 — Hermes plugin: hook + session-start prompt

**Repo:** sibling `the-librarian-hermes-plugin`.

**Description:** Equivalent to T5.1 for Hermes. `conv_id` = `hermes:<channel-id>:<thread-id>`. Session-start prompt fires the first time the agent is invoked in a new thread.

**Acceptance criteria:**
- [ ] First message in a new Discord/Slack thread triggers the hook
- [ ] Subsequent messages re-inject state
- [ ] Multiple threads in the same channel get distinct conv_states

**Verification:**
- [ ] Manual test against a Hermes agent
- [ ] Unit tests for the conv_id derivation

**Pre-work:**
- [ ] **Verify Hermes has a hook surface equivalent to UserPromptSubmit.** If not, this task blocks on adding one.

**Scope:** L

**Dependencies:** PR 2; Hermes hook-surface verification.

#### T5.3 — CLI wrapper: conv_id from env

**Repo:** `packages/cli` in this repo.

**Description:** The CLI is mostly one-shot — it has no real "conversation" — but for symmetry, generate or accept a `conv_id` per invocation. For interactive CLI use, persist across the session.

**Acceptance criteria:**
- [ ] Each CLI invocation has a `conv_id`
- [ ] `--conv-id` flag accepts an override
- [ ] Interactive sessions persist the conv_id across commands

**Verification:**
- [ ] Unit tests for the conv_id derivation logic
- [ ] Manual CLI session

**Files likely touched:**
- `packages/cli/src/runtime.ts`
- `packages/cli/src/bin.ts`
- corresponding tests

**Scope:** S

**Dependencies:** PR 2.

### Phase 5 risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Hermes lacks a `UserPromptSubmit`-equivalent hook | unknown | high | **Verify before starting T5.2.** If absent, add it to Hermes core first. This may block T5.2 indefinitely. |
| Signal-precedence chain implementation differs subtly between Claude and Hermes plugins | high | medium | Extract the precedence logic into `@librarian/lifecycle` (existing package) so both plugins call the same function. Plugin code shrinks to "fetch signal, call precedence helper, prompt or assign." |
| Session-start prompt UX in Claude Code (a CLI) is awkward | medium | medium | First implementation: simple inline prompt that reads stdin. Iterate if it's painful. |
| Compaction window between hook firing and tool call dropping state | low | medium | The hook fires on `UserPromptSubmit`, before the LLM is invoked. State is in the next turn's context window from the start; compaction can't drop it mid-turn. |

### Checkpoint: end of Phase 5

- [ ] All three sibling PRs merged
- [ ] Manual end-to-end: open Claude Code in `~/code/X`, see signal-rule pre-selection, confirm, write a memory, recall in same session, switch to a different conversation, confirm domain isolation
- [ ] Reviewed with Jim before starting Phase 6

---

## Phase 6 — Classifier in shadow mode (PR 6)

Ship the classifier service. It runs on every write, logs its verdict, but does not yet determine the persisted booleans. Validates quality before cutover.

### Pre-work

- [ ] **`classifier-implementation-spec.md`** drafted and approved. Defines model choice, serving infrastructure (in-process vs sidecar vs separate service), prompt versioning, eval-harness shape. Spec §9 flagged this as a hard prerequisite.

### Tasks

#### T6.1 — `@librarian/classifier` package skeleton

**Description:** New package owning the local-model lifecycle, the classification prompt, the JSON parser, the timeout/fallback logic. Exposes a single function: `classify({title, body, tags}): Promise<{is_global, requires_approval, fallback_used, raw_output, latency_ms}>`.

**Acceptance criteria:**
- [ ] Package loads model on startup (or lazily on first call — TBD per the impl spec)
- [ ] `classify` returns within 500ms or returns fallback
- [ ] Returns `fallback_used: true` on timeout, malformed JSON, or service unavailable
- [ ] Conservative fallback values per D20: `requires_approval: true, is_global: false`

**Verification:**
- [ ] Unit tests with a mocked model that returns each branch
- [ ] Integration test against the real local model (gated behind a flag to keep CI fast)

**Files likely touched:**
- `packages/classifier/src/index.ts`
- `packages/classifier/src/prompt.ts`
- `packages/classifier/src/json-parser.ts`
- `packages/classifier/src/model-runner.ts`
- corresponding tests

**Scope:** L

**Dependencies:** classifier-implementation-spec.

#### T6.2 — Wire classifier into `remember` (log-only / shadow mode)

**Description:** Call the classifier on every `remember`. Append a `memory.classified` event to `events.jsonl` with `{memory_id, input, classifier_output, latency, fallback_used}`. Continue to derive persisted booleans from category (legacy logic from T1.3).

**Acceptance criteria:**
- [ ] Every `remember` call appends one `memory.classified` event
- [ ] The persisted memory's `is_global`/`requires_approval` still come from category derivation
- [ ] Classifier failures do not block `remember` (logged + fallback used)

**Verification:**
- [ ] Integration test: write a memory, assert the ledger has both `memory.created` and `memory.classified`
- [ ] Failure-mode test: stop the classifier; assert `remember` still succeeds

**Files likely touched:**
- `packages/mcp-server/src/mcp/tools/remember.ts`
- `packages/core/src/store/memory-store.ts` (event append)
- `packages/core/src/schemas/events.ts` (new event type)
- corresponding tests

**Scope:** M

**Dependencies:** T6.1.

#### T6.3 — Dashboard: classifier-vs-derived disagreement view

**Description:** New page or panel showing memories where the classifier's verdict differs from the category-derived value. Owner can spot-check classifier quality before cutover.

**Acceptance criteria:**
- [ ] Page lists memories with `classifier.requires_approval ≠ derived.requires_approval` or `classifier.is_global ≠ derived.is_global`
- [ ] Shows both verdicts side-by-side
- [ ] Sortable by latency, by date, by disagreement direction

**Verification:**
- [ ] Component test
- [ ] Manual: run the classifier in shadow mode for a few days, review the page

**Files likely touched:**
- `apps/dashboard/app/(memories)/classifier-quality/page.tsx`
- corresponding actions

**Scope:** M

**Dependencies:** T6.2.

#### T6.4 — Releasability gate for PR 6

**Acceptance criteria:**
- [ ] All existing tests pass
- [ ] Classifier service runs in production for at least one week with no `remember` failures attributable to it
- [ ] Owner has reviewed the disagreement view and judged classifier quality acceptable

**Scope:** XS

**Dependencies:** T6.1–T6.3, plus elapsed-time validation.

### Phase 6 risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Classifier quality is poor (high disagreement rate, lots of false positives on `requires_approval`) | medium | high | Shadow mode is designed for exactly this. Iterate on the prompt. Acceptable disagreement rate is a soft judgement call; owner decides when good-enough. |
| Local model adds significant startup time to mcp-server | medium | medium | Lazy-load on first `remember`. First call is slow; subsequent are fast. Or run as a sidecar service that warms independently. |
| `memory.classified` event volume bloats `events.jsonl` | medium | medium | Each event is small (~500 bytes). At 100 memories/day = 50KB/day. Worst case: rotate the event log monthly. |
| The classifier prompt drifts from spec semantics over iteration | medium | medium | Version the prompt in `@librarian/classifier/prompt/v1.md` etc. Every `memory.classified` event records the prompt version. The eval harness can replay against any version. |

### Checkpoint: end of Phase 6

- [ ] All Phase 6 tasks merged
- [ ] Classifier shadow-mode running on canonical instance
- [ ] Disagreement view reviewed; classifier quality judged acceptable by Jim
- [ ] **Explicit go/no-go decision with Jim before starting Phase 7.** This is the irreversible step.

---

## Phase 7 — Classifier cutover (PR 7)

Flip source-of-truth. Drop the legacy columns. This is the only phase that is hard to roll back — drops are destructive in SQLite without a re-projection.

### Tasks

#### T7.1 — Flip `remember` to persist classifier verdict

**Description:** Update `remember` so the persisted `is_global` / `requires_approval` come from the classifier, not category derivation. Remove the legacy derivation code path from `normalizeMemoryInput`.

**Acceptance criteria:**
- [ ] `remember` persists the classifier's verdict
- [ ] Legacy derivation code is deleted, not just bypassed
- [ ] Tests previously asserting category-derived values are updated to assert classifier-driven values (using a deterministic test classifier mock)

**Verification:**
- [ ] Unit + integration tests
- [ ] `pnpm test`

**Files likely touched:**
- `packages/mcp-server/src/mcp/tools/remember.ts`
- `packages/core/src/constants.ts` (`normalizeMemoryInput`)
- `packages/core/src/store/memory-store.ts`
- corresponding tests

**Scope:** M

**Dependencies:** PR 6 validation.

#### T7.2 — Re-run migration to convert category → tag

**Description:** Re-run `scripts/migrate-add-domain-and-conv-state.mjs` with cutover-mode behaviour: for each historical memory, append the old category value to `tags[]`. Idempotent (running twice produces no duplicates).

**Acceptance criteria:**
- [ ] Every memory previously carrying `category='tools'` now carries `tags: [..., 'tools']`
- [ ] No memory loses information
- [ ] Idempotent

**Verification:**
- [ ] Test fixture covers the conversion
- [ ] Manual spot-check 20 memories after running

**Files likely touched:**
- `scripts/migrate-add-domain-and-conv-state.mjs` (or a sibling script)
- corresponding tests

**Scope:** S

**Dependencies:** T7.1.

#### T7.3 — Drop `category`, `visibility`, `scope` columns

**Description:** Migration to drop the three legacy columns. Applied at mcp-server startup via the projection-rebuild flow. The projection handlers for old `memory.created` events ignore those fields rather than reading them.

**Acceptance criteria:**
- [ ] After migration, the `memories` table has no `category`, `visibility`, or `scope` columns
- [ ] Old `memory.created` events in `events.jsonl` still parse (projection handler ignores legacy fields)
- [ ] Re-running migration is idempotent (drop-if-exists semantics)

**Verification:**
- [ ] Schema-introspection test
- [ ] Projection-rebuild test from a JSONL containing both pre- and post-cutover events

**Files likely touched:**
- `packages/core/src/store/projection.ts`
- corresponding tests

**Scope:** M

**Dependencies:** T7.2.

#### T7.4 — Remove `PROTECTED_CATEGORIES`, `Category` enum, `Visibility` enum, `Scope` enum

**Description:** Source-level cleanup. Delete all references to the removed concepts in `@librarian/core`, `@librarian/mcp-server`, dashboard, integration docs.

**Acceptance criteria:**
- [ ] `grep -rn "PROTECTED_CATEGORIES\|Visibility\|Scope\|Category" packages/` returns only references in irrelevant contexts (e.g. doc comments about migration history)
- [ ] All tests pass
- [ ] All packages build clean

**Verification:**
- [ ] Full test suite green
- [ ] `pnpm build` succeeds across the workspace

**Files likely touched:** broad. Audit pass across the workspace.

**Scope:** L (touches many files but each touch is small)

**Dependencies:** T7.3.

#### T7.5 — Releasability gate for PR 7

**Acceptance criteria:**
- [ ] All tests pass
- [ ] Manual smoke: write a memory in each domain; recall it; verify isolation
- [ ] Backup of pre-cutover JSONL taken before T7.3 runs in production

**Scope:** XS

**Dependencies:** T7.1–T7.4.

### Phase 7 risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Column drop is irreversible without re-projection from JSONL | high | medium | Take a full JSONL backup before T7.3 in production. Projection can always be rebuilt from JSONL; we never lose data, only the SQL-level shape. |
| A consumer somewhere still reads `category` and breaks silently | medium | high | T7.4 grep audit covers source; e2e tests cover behaviour. Watch logs after deploy. |
| The classifier's first-day-of-production verdicts are worse than category-derived | medium | medium | Phase 6 validation should catch this. If it surfaces post-cutover, owner overrides are the recovery path — every override is recorded and can be reviewed. |

### Checkpoint: end of Phase 7

- [ ] All Phase 7 tasks merged
- [ ] Production migration run with JSONL backup
- [ ] One week of post-cutover operation reviewed; no regressions
- [ ] Reviewed with Jim before starting Phase 8

---

## Phase 8 — Documentation (PR 8)

Can be written progressively from PR 5 onward. Final pass after PR 7.

### Tasks

#### T8.1 — Integration docs

**Description:** Update `docs/integration-docs-memory-verbs.md` and per-integration READMEs (Claude plugin, Hermes plugin, CLI) to reflect the new model. Document the conv_state hook contract, the signal-precedence chain, and the absence of category/visibility/scope.

**Acceptance criteria:**
- [ ] No remaining references to removed concepts
- [ ] New harness integrators have a clear "how to implement the hook" guide
- [ ] CLAUDE.md / SOUL.md guidance updated to reflect that agents no longer set policy fields

**Files:** `docs/`, sibling repo READMEs, `CLAUDE.md`, agent SOUL files.

**Scope:** M

#### T8.2 — Classifier prompt documentation

**Description:** Document the classifier prompt design, versioning workflow, and eval-harness usage in `docs/classifier.md`.

**Files:** `docs/classifier.md` (new).

**Scope:** S

#### T8.3 — Update `/lib-session-*` command help

**Description:** Per-command help text for the `/lib-session-*` family now mentions domain inheritance on resume. The `/lib-toggle-private` doc clarifies it integrates with conv_state.

**Files:** `.claude/commands/lib-session-*.md`, `.claude/commands/lib-toggle-private.md`.

**Scope:** XS

### Checkpoint: end of Phase 8 (project complete)

- [ ] All documentation updated
- [ ] Spec status moved to "Implemented YYYY-MM-DD"
- [ ] Working doc archived alongside the spec

---

## Open questions

- **Classifier-implementation-spec.** Must be drafted before PR 6 starts. Model choice is the key undefined.
- **Hermes hook surface.** Needs verification before T5.2 starts. If missing, T5.2 blocks on adding one to Hermes core.
- **Single-PR vs split-PRs for Phase 4.** T4.1–T4.5 collectively might be too large for a single review. Split into 2-3 sub-PRs if so.
- **Acceptable classifier quality threshold.** §6 Checkpoint says "judged acceptable by Jim." Worth defining a concrete metric before shadow mode starts — e.g. ≥95% agreement with derived values on the migration backfill, plus owner sampling of disagreements.
- **`memory.classified` event volume.** ~500 bytes × write rate. If this becomes a concern, consider sampling (log only a subset) or rotating the event log.

---

## Verification before starting

- [ ] Spec read and approved
- [ ] Component dependency graph confirms PR order
- [ ] Risks per phase acknowledged
- [ ] Classifier-implementation-spec prerequisite scheduled
- [ ] Hermes hook-surface verification scheduled
- [ ] Reviewed with Jim before starting PR 1

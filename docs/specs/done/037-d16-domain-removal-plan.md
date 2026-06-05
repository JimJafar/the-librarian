# Plan 037 — D16: remove the memory-domain-isolation subsystem

**Implements:** spec 035 / plan 036 **Phase 0** decision **D16** ("no memory scoping/partitioning — drop the domains store + the domain seam-bypass"). **Status:** Draft for review.

On inspection, `domain` is not a stray column — it's the spec 021/022 isolation model, woven through the verb layer, stores, schema (3 tables + 3 columns), CLI, and dashboard. This plan sequences its removal.

---

## Scope

**Remove (domain scoping + the domains management feature):**
- `recall` domain scoping (`include_other_domains`, the domain filter).
- `remember` domain-based proposal routing (§4.14: unresolvable domain → proposal queue).
- `mcp/domain-resolution.ts` (`resolveCallerDomain`).
- The `domains` store + table + `seedDomains`; the dead `signal_rules` + `token_domain_bindings` tables.
- The `domain` columns on `memories`, `handoffs`, `conversation_state`.
- The `/domains` dashboard page + the tRPC `domains` router.
- All `domain` plumbing in tools / schemas / CLI / dashboard.

**Keep (explicitly NOT D16):**
- `is_global` / `requires_approval` — these are **classifier verdicts**, not domain scoping. They're coupled to the classifier worker and retire *with it* in Phase 4. `deriveDomainColumns` becomes `deriveClassifierColumns` (drops only the domain element).
- The proposal flow — still driven by classifier verdicts (`requires_approval`) + `approve_proposal` (see transition below).
- `category`, and non-domain fields.

## Resolved decisions
- conv_state `domain`: **stripped now** (no deploy until 1.0.0 → no migration constraint).
- `domain` columns + dead tables: **dropped now**.
- `is_global` / `requires_approval`: **kept** (classifier verdicts; removed in Phase 4).
- CI: **retire `check:schema-version`** in the schema PR (spec resolution #6; cheaper than re-recording the fingerprint per schema change). Update the `check:test-count` baseline when domain tests are deleted. Keep `check:storage-fixture` working (defer its corpus retarget to Phase 3).

## The proposal-flow transition (the open question — resolved)
`remember` §4.14 routes an *unresolvable*-domain write to the proposal queue. Post-D16 there is no domain to be unresolvable, so **`remember` writes directly** (or `pendingClassification` when the classifier is active). Proposals still arise from classifier verdicts and `approve_proposal`. The "risk-driven" proposal model (supersede / uncertain / learn) is the **Phase-4 consolidator's** job; until then this transitional state is acceptable — no proposal-flow machinery is removed, only the *domain trigger*.

## PR sequence (3 PRs, each green + behaviour-coherent)

**D16.1 — Memories.** `recall` (drop scoping), `remember` (drop domain-proposal routing), `memory-store` (createMemory `domain` option + `searchMemories` domain filter), memory/events schemas, `constants` (`NewMemory.domain`), `trpc/memories` (`MemoryShape.domain`), `visibility`; projection `memories.domain` column + `deriveDomainColumns` → `deriveClassifierColumns`. Delete `remember-domain` / `recall-domain` MCP tests. (`domain-resolution` stays — handoffs still use it.)

**D16.2 — Handoffs.** handoff tools (store/claim/list drop `resolveCallerDomain`), `handoff-store` (contexts / `HandoffDetail` / `HandoffRow` / queries drop domain), `trpc/handoffs`, CLI `handoffs-list`/`show`, dashboard handoffs `detail-view`, handoff schema; projection `handoffs.domain` column + its index. Remove `mcp/domain-resolution.ts` (+ test) — now unused.

**D16.3 — Conv-state + management + schema.** conv-state-upsert tool, `conversation-state-store`, `conv-state-render`, conversation-state schema (drop domain); projection `conversation_state.domain` column. Remove the domains feature: `DomainsStore` (+ test), the `domains`/`signal_rules`/`token_domain_bindings` tables + `seedDomains`, the `domains` field on `LibrarianStore` + `createDomainsStore` + core exports, the tRPC `domains` router (+ test) + the `router.ts` mount, the dashboard `/domains` page + actions + component (+ test). Bump `PROJECTION_SCHEMA_VERSION`; retire `check:schema-version`; update the `check:test-count` baseline.

## Verification (each PR)
`lint` + `typecheck` + full `test` + `check:no-store-bypass` green; CHANGELOG entry for the user-visible changes (recall no longer domain-scoped; `/domains` page removed; `handoffs show` drops the `domain` line).

## Risks / notes
- The on-disk schema drop is irreversible, but there's no deploy until 1.0.0 (no live migration).
- Removing recall scoping is a deliberate behaviour change (D16: "relevance from retrieval, not walls").
- The classifier entanglement (`is_global`/`requires_approval`/`pendingClassification`) is left intact — D16 touches only the domain parts; Phase 4 removes the classifier.
- `migrate-add-domain-and-conv-state.mjs` (a one-shot migration script) is retired in D16.3.

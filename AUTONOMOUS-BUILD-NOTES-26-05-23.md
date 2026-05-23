# Autonomous Build Notes — 2026-05-23

**Task:** Implement `docs/specs/implementation-plan.md` (autonomous mode).
**Driver:** Guybrush (claude-code, autonomous build)

Increments shipped this day, each its own PR:

1. `feat/naming-contract-foundation` — Stage 1.2 resolver core (merged, PR #70).
2. `feat/naming-contract-mcp-wiring` — Stage 1.4 MCP soft-mode wiring (merged, PR #71).
3. `feat/naming-contract-cli-identity` — Stage 1.4 CLI caller canonicalisation (merged, PR #72).
4. `feat/naming-contract-audit` — Stage 1.1 baseline audit dry-run (merged, PR #73).
5. `feat/naming-contract-dashboard-actor` — Stage 1.4 dashboard-admin actor (merged, PR #74).
6. `feat/naming-contract-backfill` — Stage 4.1 Phase-3 caller-id backfill (this PR).

---

## Increment 6 — Stage 4.1 Phase-3 caller-id backfill

The write step that pairs with Increment 4's read-only audit. `backfillCallerIds(store, opts)`
in `@librarian/core` (+ `scripts/backfill-agent-ids.mjs`, `pnpm backfill:agent-ids`) rewrites
stored caller ids to canonical form: normalises every non-empty id, applies a **one-time
backfill alias map**, never touches `unknown-agent`, is a no-op in dry-run, and is idempotent.

Each subsystem is reattributed via its own **durable** path (this is the crux of the design):

- **Memories** are JSONL-canonical (`events.jsonl` is the source; SQLite is a rebuilt
  projection), so reattribution appends a `memory.bulk_updated` event via `bulkUpdateMemory`.
  A direct SQL UPDATE would be clobbered on the next projection rebuild.
- **Sessions** are SQLite-authoritative since R3 (the `sessions` table survives schema bumps;
  a *warm* rebuild refreshes only the timeline projection — verified in `projection.ts`
  `rebuildSessionIndex`), so reattribution is a direct, durable UPDATE on `sessions`
  (`created_by_agent_id` / `current_agent_id`) and `session_state_changes.actor_agent_id`.
  Caveat: a *cold* rebuild (empty `sessions` table, e.g. after deleting `librarian.sqlite`)
  replays the legacy JSONL ledger and would reintroduce `claude`; the backfill is idempotent,
  so re-running after a from-scratch rebuild is the intended recovery (standard for migrations).

Dry-run against the repo's `./data` confirmed: `system → system-migration` (2 memories),
`claude → claude-code` (8 sessions), `codex`/`opencode`/`pi` left untouched.

Also fixed the CLI `seed` to write `system-migration` instead of a bare `system`, so it stops
reintroducing the legacy id (`packages/cli/src/runtime.ts`).

### Backfill decisions (RESOLVED with Jim, 2026-05-23)

- [x] **`system` → `system-migration`.** Confirmed. The seed's bootstrap memories are placed by
  a system process, so `system-migration` (§6's designated backfill actor) is the right id; the
  seed now writes it directly. No spec conflict.
- [x] **`claude` → `claude-code`: backfill the rows, but add NO live alias.** This needs care:
  §8 and §14 (open-question #1) **explicitly resolved against** an alias, keeping `claude`
  distinct from a *future* `claude` surface. Surfaced that conflict to Jim. Resolution: the
  existing stored `claude` rows are known *historical Claude Code* data, so the one-time
  backfill rewrites them to `claude-code`, **but** the resolver's live alias map stays empty
  for `claude` — honouring the spec's "keep `claude` free going forward". The backfill alias
  map (`scripts/backfill-agent-ids.mjs`) is therefore deliberately SEPARATE from the live
  resolver alias map. No spec change required.

### Note on rewriting `session_state_changes.actor_agent_id`

The backfill also rewrites the historical actor on past state transitions (`claude` →
`claude-code`). This is the *same* actor under its canonical name (not falsifying history), and
keeps the state-change audit consistent with the reattributed `sessions` rows. Flagged here in
case you'd prefer audit rows frozen at their original (pre-canonical) spelling.

---

## Increment 5 — Stage 1.4 dashboard admin actor

Both tRPC routers attributed admin mutations to a bare `"dashboard"` actor; spec §6/§7.5
mandate the reserved `dashboard-admin`. Now sourced from core's
`SYSTEM_ACTOR_IDS.dashboardAdmin` (single source of truth) in `trpc/memories.ts` and
`trpc/sessions.ts`. New tRPC test asserts an admin archive with no `agent_id` records the
`dashboard-admin` actor in the ledger.

Remaining §7.5 (deferred): the dashboard **UI** changes — agent-filter dropdowns showing
canonical ids only, `unknown-agent` marked legacy, system actors grouped — are a frontend
task for a later increment.

- [ ] **Fast-follow:** a mirror test for the sessions router's `dashboard-admin` fallback.
  The memories router has one; the sessions router uses the identical centralised
  `?? DASHBOARD_AGENT_ID` pattern through `runAdminAction`, but its actor is recorded as a
  session **state change** (not a timeline event), so asserting it needs the state-change
  read surface rather than `sessions.events`. Low risk (shared constant), left untested for now.

---

## Increment 4 — Stage 1.1 baseline audit (Phase 0 dry-run)

Pure `auditCallerIds(rawIds)` in `@librarian/core` + a read-only
`scripts/audit-agent-ids.mjs` (`pnpm audit:agent-ids`). Runs `normaliseCallerId` over the
existing stored ids (memories.agent_id, sessions.created_by_agent_id / current_agent_id),
groups them by canonical form, flags collapse groups and unnormalisable ids — **changes
nothing** (no aliases applied; alias decisions wait for human review per §10).

### Audit findings against the repo's `./data` (for the eventual backfill — Workstream 1.3/Phase 3)

Ran `pnpm audit:agent-ids`: **5 distinct ids — `claude`, `codex`, `opencode`, `pi`,
`system` — all already canonical, no collapse groups, none invalid.** Two points to decide
before the Phase-3 backfill:

- [x] **`claude` vs `claude-code`.** RESOLVED in Increment 6: backfill the stored rows to
  `claude-code`, but add **no live alias** (the spec keeps `claude` distinct going forward).
- [x] **`system` as an agent_id.** RESOLVED in Increment 6: backfill to `system-migration` and
  fix the CLI seed to write it directly. See Increment 6 for the full rationale.

---

## Increment 3 — Stage 1.4 CLI caller canonicalisation

The CLI already had `callerAgent` (`--agent` / `LIBRARIAN_AGENT_ID` / default `cli`), so
§7.3's flag contract existed; the gap was **canonicalisation** — `--agent "Guybrush"` stored
`Guybrush`, diverging from the MCP boundary. `callerAgent` now routes through
`normaliseCallerId`, so all CLI attribution (every command funnels through it) is canonical.

- The CLI is a trusted local boundary (no token), so plain `normaliseCallerId` is used — not
  the role-gating `resolveCaller`. That keeps `cli` (a reserved id) valid as the default
  operator actor, per §4.4/§7.3.
- A malformed `--agent "!!!"` throws → surfaces as a clean `Error: …` (exit 1) via the
  runtime try/catch.
- Existing `--agent bede` / `cli` tests are unaffected (they normalise to themselves).

---

## Increment 2 — Stage 1.4 MCP surface wiring (soft mode)

Routes agent identity through `resolveCaller` at the **single MCP chokepoint**
(`scopeAgentArgs` in `packages/mcp-server/src/mcp/visibility.ts`) — every agent-facing
tool already funnels through it, matching the spec's "resolve once at dispatch/tool-entry"
(§7.2). Soft-migration mode, so missing identity is unchanged.

Behaviour now:

- **Normalisation** — a supplied `agent_id` is canonicalised before storage
  (`Guybrush (Hermes)` → `guybrush-hermes`).
- **No impersonation** — a mapped token + a *conflicting* request-body `agent_id` is now
  **rejected** (§5.3/§7.2) instead of silently overwritten. This intentionally changes the
  old "MCP start_session refuses to honour a caller-supplied agent_id" test, which encoded
  the silent-overwrite behaviour — it now asserts rejection (a stronger guarantee).
- **Reserved gating** — an ordinary agent cannot claim `system-*`/`dashboard-*`/`cli`.
- **Soft fallback** — a shared token with no id still resolves to `unknown-agent`.
- **Admin** path unchanged (`admin: true`, no `agent_id` pinning).

Also: `ResolveCallerInput`'s three id fields now explicitly accept `| undefined` so trust
boundaries can pass optional ids without conditional-spread gymnastics under
`exactOptionalPropertyTypes`.

**Deferred from 1.4 (next increments):** alias-map application (would remap `bede →
guybrush` and is a Phase-3 backfill concern — applying it live now changes attribution that
several MCP tests assert literally), CLI `--agent`/`LIBRARIAN_AGENT_ID`, dashboard/tRPC
dropdowns, and a soft-mode warning log for missing identity. Plus 1.1 audit + 1.3 store
`actor_kind` column.

---

## Scope decision for this run

The implementation plan spans **four stages** (naming foundation → curator → harness
integrations across 5 harnesses → naming hard-enforcement) — realistically weeks of work
and far more than one safe, reviewable PR.

Per the plan's own sequencing principle ("the naming contract … *brackets* them. Its
foundation must land first"), this run delivers **Stage 1, Workstream 1.2 — the resolver
core**: the pure, fully-tested, zero-regression-risk foundation that unblocks everything
else. It adds new code in `@librarian/core` and wires nothing yet, so no existing
behaviour changes.

### Delivered this run

- `normaliseCallerId(raw)` — §4.2 normalisation algorithm.
- Alias resolution with loop/recursion rejection — §4.4.
- Reserved-namespace constants + enforcement (`system-*`, `dashboard-*`, `cli`) — §4.4.
- System actor ids — §6.
- `resolveCaller(input): ResolvedCaller` — §7.1 (precedence, normalise, alias, validate).
- Full unit-test coverage per §11 (unit-test list).

### Deferred to follow-up increments (with rationale)

These were intentionally **not** done in this PR to keep it focused and low-risk:

1. **Workstream 1.1 — Baseline audit script.** Read-only dry-run over existing stored ids.
   Easy follow-up; uses the resolver shipped here.
2. **Workstream 1.3 — Store attribution.** Persisting canonical ids + `actor_kind`
   column. Touches the store schema/projection; deserves its own migration-aware PR.
3. **Workstream 1.4 — Surface wiring (soft mode).** MCP `scopeAgentArgs`
   (`packages/mcp-server/src/mcp/visibility.ts:25` currently pins `agent_id` from auth
   context), CLI `--agent`/`LIBRARIAN_AGENT_ID`, dashboard dropdowns. This rewires the
   live identity path and several integration tests assert the current `unknown-agent`
   behaviour — higher risk, wants a dedicated PR + soft-warning rollout.
4. **Stages 2–4** (curator, harness integrations, hard enforcement) — sequenced after
   Stage 1 lands per the plan.

---

## Code review outcome

A `code-reviewer` sub-agent reviewed the resolver across all five axes and probed 11+
escalation/bypass vectors against the security boundary. Verdict: **ship-with-fixes** —
**zero Critical, zero Important**; all findings Suggestion-tier. Confirmed: agent→reserved
escalation is blocked via raw input, alias target, allowlist, and token-bound paths;
token-binding can't be bypassed (injected mismatch rejected too); no ReDoS in the
normalisation regexes (all linear).

Suggestions actioned this run:

- Added a cheap pre-normalisation length guard (`MAX_RAW_LENGTH = 1024`) so megabyte-scale
  input is rejected before the Unicode/regex passes — matters once this is wired to the
  attacker-facing MCP/CLI boundary.
- Clarified the alias single-hop/chain-rejection comment.
- Added tests: injected-vs-token mismatch, invalid token-bound id, raw-length guard,
  `isReservedId` coverage, `dashboard-*` (non-`dashboard-admin`) classification. (150 tests.)

## Points for Jim to consider

- [ ] **`ResolvedCaller.alias_applied` semantics.** The spec (§7.1) only declares the field;
  this implementation defines it as *the pre-alias normalised id* (set only when an alias
  actually fired). When Workstream 1.3 persists it to the audit trail, confirm the store
  consumer agrees on that meaning (pre-alias source vs. the literal alias key).
- [ ] **`cli` reserved-id role gating.** The spec's role enum is `agent|admin|system` (no
  `cli` role), but `cli` is a reserved id. I gated it as "not usable by `role: "agent"`"
  (so admin/system/local-operator paths may use it). Confirm that matches your intent for
  §7.3 manual CLI calls, or whether `cli` should get a first-class role.
- [ ] **Two `DEFAULT_AGENT_ID` definitions.** `unknown-agent` is declared in *both*
  `packages/core/src/constants.ts` and `packages/core/src/schemas/common.ts:173`
  (same value, exported via different paths). Pre-existing; harmless but worth de-duping.

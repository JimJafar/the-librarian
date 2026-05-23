# Autonomous Build Notes — 2026-05-23

**Task:** Implement `docs/specs/implementation-plan.md` (autonomous mode).
**Branch:** `feat/naming-contract-foundation`
**Driver:** Guybrush (claude-code, autonomous build)

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

## Points for Jim to consider

_(populated as the build proceeds)_

- [ ] **Two `DEFAULT_AGENT_ID` definitions.** `unknown-agent` is declared in *both*
  `packages/core/src/constants.ts` and `packages/core/src/schemas/common.ts:173`
  (same value, exported via different paths). Pre-existing; harmless but worth de-duping.

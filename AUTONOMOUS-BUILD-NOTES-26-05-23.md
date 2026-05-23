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

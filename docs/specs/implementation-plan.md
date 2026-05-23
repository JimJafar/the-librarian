# Implementation Plan: Curator, Harness Lifecycle, and Naming Contract

**Author:** Guybrush, with Jim
**Date:** 2026-05-23
**Status:** Draft — sequencing agreed in claude-code planning session (2026-05-23)

Covers the build order for the three specs:

- [`memory-curator-spec.md`](./memory-curator-spec.md)
- [`harness-commands-and-lifecycle-spec.md`](./harness-commands-and-lifecycle-spec.md)
- [`agent-naming-contract-spec.md`](./agent-naming-contract-spec.md)

---

## 1. Sequencing principle

The naming contract is **not a peer** of the other two — it *brackets* them. Its foundation must land first (both features depend on canonical caller identity), and its hard enforcement must land last (the enforcement trigger literally depends on the harness integrations being done). The two features sit in between and are independent of each other.

```
naming(core/soft) ──► curator ──► harness(all 5) ──► naming(backfill + hard-enforce)
       │                 │              │                         ▲
   unblocks all     small first    satisfies naming         condition met
                    consumer       Phase 2 per harness    (integrations + 7 clean days)
```

**Invariants that hold across every stage:**

- **No new MCP verbs.** Curation is scheduler-driven; privacy is local-only; naming only tightens existing schemas. (Objective #1.)
- **Off-record private = zero Librarian calls** beyond closing any active session at the transition.
- **Tokens authenticate, names identify.** Identity comes from the trusted boundary, never trusted from the model.
- **Agent-facing simplicity.** The only thing an agent must do is send its `agent_id` (ideally wrapper-injected).

---

## 2. Stage 1 — Naming foundation (Phases 0–2, soft mode)

Pure server-side work; nothing rejects yet, so no behaviour breaks. Unblocks both features.

**Workstream 1.1 — Baseline audit (naming Phase 0)**
- Enumerate distinct `agent_id` / `created_by_agent_id` / `current_agent_id` values.
- Run `normaliseCallerId` in dry-run; produce collapse groups and collision candidates.
- Leave `unknown-agent` untouched.

**Workstream 1.2 — Resolver core**
- `normaliseCallerId` (§4.2) + unit tests (§11).
- `ResolveCallerInput` / `ResolvedCaller` resolver (§7.1): injected > authenticated > (soft) fallback; normalise; aliases; validate token binding / allowlist / reserved namespaces / role mismatch.
- Alias config/table (§4.4) + reserved namespaces (`system-*`, `dashboard-*`, `cli`).

**Workstream 1.3 — Store attribution**
- Persist canonical ids in attribution fields (§7.4); raw ids only in metadata/audit.
- Add `actor_kind` (`agent`/`admin`/`system`/`cli`) column where schema-feasible; else enforce at resolver + audit metadata.

**Workstream 1.4 — Surface wiring (soft)**
- MCP: resolve once at dispatch; never overwrite a supplied `agent_id`; reject mismatch + reserved misuse; session-lifecycle tools record the acting caller.
- CLI: `--agent` / `LIBRARIAN_AGENT_ID`.
- Dashboard/tRPC: canonical-id dropdowns, `unknown-agent` marked legacy, system actors grouped.
- Run identity in **soft-warning** mode: log missing/odd identity, do not reject (except hard mismatch).

**Exit criteria:** resolver live in soft mode; attribution being collected cleanly; token-bound mismatches rejected; no regressions.

---

## 3. Stage 2 — Memory curator

The most self-contained feature and the cleanest first consumer of the naming contract (single `system-memory-curator` actor). Operates on existing stored memories — no dependency on the harness work.

**Workstream 2.1 — Data model**
- `memory_curation_runs` + `memory_curation_operations` tables (§8).
- `curator_note` nullable column on `memories` carrying `{ text, supersedes, run_id, operation_id }`.

**Workstream 2.2 — Evidence + detection**
- Slice-scoped gathering (`common_global`, `common_project`, per-`agent_private`) with secret/cross-slice redaction before the LLM pass (§9).
- Tombstone fingerprint pre-pass (normalised content hash) blocking resurrection (§9.1, §10.3).

**Workstream 2.3 — LLM pass + governance**
- Provider/endpoint/token/model config; prompt assembly system → evidence+candidates → admin addendum (advisory only) (§10.4).
- Validation + apply policy (§10.5, §11): protected categories → **proposal** with `curator_note.supersedes`; protected pure-archive → skip+audit; non-protected → auto-apply under `default_auto_apply` (`safe_only` default) + confidence threshold; superseded sources archived **atomically**; slice/secret guards skip.

**Workstream 2.4 — Trigger + worker**
- `enqueueDueMemoryCurationRuns(reason: "schedule" | "manual" | "maintenance")` (§12).
- Scheduler/worker firing at the admin-configured interval/time (default every 1 day at 03:00); input-hash skip; manual/maintenance may bypass skip (§10.2, §14).
- Actor is `system-memory-curator` (consumes Stage 1).

**Workstream 2.5 — Admin cockpit (dashboard)**
- Enable/disable · schedule (`every N days at HH:MM`) · LLM config (token via admin secret-store) · advisory prompt addendum · read-only observability (per-action counts) · run-now (shares the scheduler enqueue path) (§7.1, §13).

**Tests:** schedule, fingerprint/resurrection, addendum, run-now, protected proposal + supersedes, agent-private isolation (§15).

**Exit criteria:** curator runs on schedule and via run-now; emits governed ops; admin can observe + configure; `safe_only` default; zero new MCP verbs.

---

## 4. Stage 3 — Harness commands & lifecycle

The largest, riskiest, most cross-cutting piece. Build per the spec's §12 rollout order. Building each integration here also satisfies naming **Phase 2** (each harness starts sending its canonical `agent_id`).

**Workstream 3.1 — Shared helper + CLI**
- `integrations/shared/librarian-lifecycle/`: local state, privacy-marker detection, short-circuit, **end-active-session-on-private-transition**, CLI calls, checkpoint rate-limiting, ref/cwd/project normalisation, idempotent start/resume/pause (§6, §9).
- Verify/extend the CLI capabilities the hooks depend on (§8).

**Workstream 3.2 — Per-harness (spec §12 order)**
1. Claude Code — `lib-toggle-private` command + hooks; `UserPromptSubmit` privacy gate.
2. Hermes — gateway middleware (synchronous privacy barrier) + lifecycle.
3. Codex — first-class hooks (`UserPromptSubmit` gate) behind `codex_hooks`; instruction fallback when off.
4. Pi — native extension with the `input` gate + `session_*` lifecycle; `pi.registerCommand`.
5. OpenCode — plugin + **spike** confirming whether `tui.command.execute` is a pre-agent gate; auto-start stays off and NL markers best-effort until it clears.

**Workstream 3.3 — Lifecycle behaviour**
- Start/resume on first meaningful public prompt; gated + rate-limited checkpoints; pause on exit/idle; **no heuristic auto-end**; private mode ends the active session with a neutral reason.

**Workstream 3.4 — Distribution (§7.6)**
- Package per channel (Claude Code plugin marketplace; Codex `/plugins`; Pi npm + `pi-package` keyword; OpenCode npm; Hermes gateway bundle), each **bundling the `use-the-librarian` skill** + commands/hooks/extension/plugin + MCP registration.

**Tests:** shared + per-harness + manual smoke (§11).

**Exit criteria:** privacy gate proven (or explicitly best-effort) per harness; auto session/checkpoint/pause working; packages installable; all integrations send canonical identity.

---

## 5. Stage 4 — Naming close-out (Phases 3–4, hard enforcement)

Must be last — the enforcement trigger depends on Stage 3.

**Workstream 4.1 — Backfill (Phase 3)**
- Migration: normalise non-empty ids, apply approved aliases (incl. `bede → guybrush`), record before/after counts, do **not** guess `unknown-agent`, write an audit log.

**Workstream 4.2 — Hard enforcement (Phase 4)**
- **Entry condition:** all five integrations send identity **and** no new `unknown-agent` rows for 7 consecutive days.
- Make `agent_id` required in identity-bearing schemas; remove new-call fallback to `unknown-agent`; keep `unknown-agent` only as a legacy value; dashboard warns on any new `unknown-agent` row.

**Exit criteria:** hard mode on; new `unknown-agent` attribution impossible.

---

## 6. Housekeeping (fold in opportunistically)

- Update [`docs/slash-commands.md`](../slash-commands.md) and the global `CLAUDE.md` to document `/lib:toggle-private` (sits outside the `/lib:session` family).
- Optional: add a "superseded by the spec" header to the two research docs so future readers aren't misled.

---

## 7. Dependency summary

| Stage | Depends on | Unblocks |
|---|---|---|
| 1 — Naming foundation | — | Curator, Harness |
| 2 — Curator | Stage 1 (system actor + audit attribution) | — |
| 3 — Harness | Stage 1 (`agent_id` / `--agent`) | Stage 4 trigger |
| 4 — Naming enforcement | Stage 3 (all integrations sending identity) | — |

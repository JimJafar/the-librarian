# Implementation Plan: Curator naming + job control (spec 045)

Breaks [spec 045](045-curator-naming-and-job-control-spec.md) into ordered,
verifiable tasks. Per the spec's resolved scope it lands as **two PRs**:

- **PR-1 — Behaviour** (D-1…D-6): runtime-effective toggles, unconditional
  self-gating schedulers, configurable Intake interval + Grooming schedule,
  run-now-on-disabled, honest banner. Ships to the live box first.
- **PR-2 — Rename** (D-7…D-9): mechanical `consolidator→intake` /
  grooming-sense `curator→grooming`, the eval package, string/key migrations.

PR-1's new **settings keys** are already in their final `curator.<job>.*`
namespace; PR-1's new **code symbols** ride the current names, and PR-2 renames
everything (incl. PR-1's additions), staying a pure mechanical pass.

## Architecture decisions (recap from 045)

- Self-gate per tick + always-create the scheduler = the toggle works at runtime
  (mirrors `backupScheduler`). The toggle stays; "unconditional" is internal.
- Grooming gets a wall-clock schedule (`every N days at HH:MM` — days-only, no
  calendar-month math); the schedule decides *when* a pass runs, the existing
  **input-hash idempotency** decides *which* slices work, `max_memories` bounds
  each. The old per-slice `intervalMinutes` gate is **retired** (resolves F5).
- Run-now bypasses the enable gate (admin override) — a **behaviour change**
  (F1), not current behaviour.
- "Verify" commands: `pnpm run lint`, `pnpm run typecheck`, package tests via
  `npx vitest run` in the package (rebuild `@librarian/core` first for
  cross-package consumers), `pnpm run smoke` / `healthcheck` for boot wiring.

## Dependency graph (PR-1)

```
T1 grooming config+migration ─┐
T2 intake interval config ────┼─► T10 tRPC config surface ─► T11 dashboard UX
T3 isScheduleDue ─────────────┤
T4 retire per-slice gate ─────┘
T5 intake self-gate ──┐
T6 grooming tick+sched ┼─► T7 http boot wiring ─► T8 run-now-on-disabled
T9 one enable helper ─┘                            T12 comment debt
```

---

## PR-1 — Behaviour

### Phase 1 — Config foundation

#### Task 1 — Grooming schedule config + migrations
**Description:** In `curator-config.ts`, add the Grooming schedule pair and move
the auto-apply policy keys under the job namespace; wire seed-once migrations.
**Acceptance:**
- `readCuratorConfig` returns `intervalDays` (default 1), `scheduleTime`
  (default `03:00`), `defaultAutoApply`, `autoApplyConfidence` — all from
  `curator.grooming.*`.
- `writeCuratorConfig` validates (`intervalDays` int ≥ 1; `HH:MM`; existing
  auto-apply bounds) and persists; bad input throws a teaching error.
- Migration (mirror `migrateCuratorEnablement`, seed-once/no-clobber; legacy keys
  map 1:1): `curator.default_auto_apply`→`…grooming.default_auto_apply`,
  `auto_apply_confidence` likewise; `curator.schedule.time`→`…grooming.schedule_time`,
  `curator.schedule.interval_days`→`…grooming.interval_days`.
  `curator.interval_minutes` no longer read.
**Verification:** `npx vitest run tests/curator-config.test.ts` (round-trip +
validation + migration idempotency/no-clobber).
**Dependencies:** None. **Scope:** M.
**Files:** `packages/core/src/curator-config.ts`, `tests/curator-config.test.ts`.

#### Task 2 — Intake interval config
**Description:** Add `curator.intake.interval_minutes` to the Intake config
surface (`readIntakeConfig`/`writeIntakeConfig`, used by `trpc/intake.ts`).
**Acceptance:**
- `readIntakeConfig` returns `intervalMinutes` (default 5); writer validates
  (integer ≥ 1) and persists.
**Verification:** unit test for round-trip + validation.
**Dependencies:** None. **Scope:** S.
**Files:** the intake config module + its test.

**Checkpoint A — Config:** `pnpm run typecheck` + the two config test files green.

### Phase 2 — Schedule logic

#### Task 3 — `isScheduleDue` helper
**Description:** Add a pure `isScheduleDue(now, lastRunAt, {intervalDays, time})`
to `curator-schedule.ts` beside `isIntervalDue`. **Days-only:** next fire =
`lastRunAt`'s local date `+ intervalDays` days, anchored at `time` (local).
Never-run ⇒ due at next `time`. (Deliberately no weeks/months unit — 7 = weekly,
30 ≈ monthly — which removes the calendar-month arithmetic the blind review
flagged.)
**Acceptance:**
- Returns due at most once per window; unit tests pin the day boundary, the
  interval-days arithmetic, the never-run case, and the DST-day behaviour
  (documented, not double-firing). No `setMonth`/calendar-month code.
**Verification:** `npx vitest run tests/curator-schedule.test.ts`.
**Dependencies:** None. **Scope:** M.
**Files:** `packages/core/src/curator-schedule.ts`, `tests/curator-schedule.test.ts`.

#### Task 4 — Retire the per-slice interval gate
**Description:** A scheduled/run-now grooming pass attempts **every** slice;
input-hash idempotency (`runCuration`/`findCompletedApplyRun`) skips unchanged
ones. Remove `isSliceDue`/`isIntervalDue`-based slice selection and the
`config.intervalMinutes` plumbing from the grooming pass.
**Acceptance:**
- `selectDueSlices` (or its replacement) yields all slices for the slice set;
  an unchanged slice produces no LLM call (idempotency); a changed slice runs.
- No reader of `config.intervalMinutes` remains in the grooming path.
**Verification:** `npx vitest run tests/curator-enqueue.test.ts tests/curator-tick.test.ts`.
**Dependencies:** T1 (config shape). **Scope:** M.
**Files:** `packages/core/src/curator-enqueue.ts`, `curator-tick.ts`, tests.

**Checkpoint B — Logic:** full `@librarian/core` suite green after rebuild.

### Phase 3 — Runtime control

#### Task 5 — Intake tick self-gates (D-1)
**Description:** `runConsolidatorTick` early-returns `{ran:false,reason:"disabled"}`
when `!isIntakeEnabled(store)`, mirroring grooming's gate.
**Acceptance:** disabled ⇒ no sweep; enabled ⇒ unchanged behaviour.
**Verification:** `npx vitest run tests/consolidator-tick.test.ts` (new disabled test).
**Dependencies:** None. **Scope:** S.
**Files:** `packages/core/src/consolidator-tick.ts`, test.

#### Task 6 — Grooming scheduled entry (D-3)
**Description:** Add a scheduled grooming entry that self-gates on
`config.enabled`, checks `isScheduleDue`, and runs a pass when due; keep the
post-Intake trigger. Add an `allowDisabled` (manual) seam for T8.
**Acceptance:** due+enabled ⇒ pass runs; not-due ⇒ skip; disabled ⇒ skip
(unless `allowDisabled`).
**Verification:** `npx vitest run tests/curator-tick.test.ts`.
**Dependencies:** T3, T4. **Scope:** M.
**Files:** `packages/core/src/curator-tick.ts`, test.

#### Task 7 — Boot wiring + honest banner (D-2, D-6/F22)
**Description:** In `http.ts`: create **both** schedulers unconditionally
(`tickMs>0`), Intake polling at `curator.intake.interval_minutes` (env as
default), a new Grooming scheduler polling ~15 min; run the boot scan
unconditionally (self-gates); banner reports each job's **live** enable state;
seed legacy schedule keys **before** the (now-reworded/removed) "ignored" notice.
**Acceptance:** server boots with intake disabled; flipping the setting starts
draining on the next tick with no restart; grooming runs on its schedule.
**Verification:** `pnpm run smoke` + `pnpm run healthcheck`; manual: toggle in a
local dashboard, confirm effect within one poll.
**Dependencies:** T2, T5, T6. **Scope:** M.
**Files:** `packages/mcp-server/src/bin/http.ts`.

#### Task 8 — Run-now runs a disabled job (D-4/F1)
**Description:** Move the enable gate out of the run-now path: `trpc/intake.ts`
`runNow` drops the `isIntakeEnabled` refusal; `trpc/curator.ts` `runNow` passes
`allowDisabled` so `runCuratorTick` skips the enable gate (LLM-config/token gates
still apply).
**Acceptance:** run-now executes a disabled (but configured) job; the scheduled
tick still does nothing when disabled; a no-LLM job returns a clear reason.
**Verification:** `npx vitest run` for the two trpc test files (new "run-now on
disabled" cases).
**Dependencies:** T5, T6. **Scope:** S.
**Files:** `packages/mcp-server/src/trpc/intake.ts`, `trpc/curator.ts`,
`curator-tick.ts` (allowDisabled), tests.

#### Task 9 — One enablement helper (D-5/F21)
**Description:** Collapse `isConsolidatorEnabled` to the core `isIntakeEnabled`;
update the 3 call sites.
**Acceptance:** `isConsolidatorEnabled` gone (or a thin re-export); `remember`,
`propose_memory`, `http.ts` call the single helper; behaviour unchanged.
**Verification:** `pnpm run typecheck` + mcp-server suite.
**Dependencies:** None. **Scope:** S.
**Files:** `consolidator-config.ts`, `mcp/tools/remember.ts`,
`mcp/tools/propose-memory.ts`, `bin/http.ts`.

**Checkpoint C — Behaviour end-to-end:** integration test (toggle between two
ticks changes behaviour, both directions) + manual dashboard toggle/schedule on
a local server. Full core + mcp-server suites green.

### Phase 4 — Surface + UX

#### Task 10 — tRPC config surface
**Description:** Extend `intake.setConfig`/`getConfig` with `intervalMinutes`,
and `curator.setConfig`/`getConfig` (grooming) with `scheduleEvery/Unit/Time`;
validation defers to the core writers (single source of truth).
**Acceptance:** admin can read/set each cadence over tRPC; invalid input is
rejected with a teaching error.
**Verification:** `npx vitest run` trpc tests.
**Dependencies:** T1, T2. **Scope:** M.
**Files:** `trpc/intake.ts`, `trpc/curator.ts`, schema modules, tests.

#### Task 11 — Dashboard schedule controls + run-now reasons
**Description:** Curator page: Intake "Run every [N] minutes"; Grooming "Run
every [N] days at [HH:MM]"; surface the run-now result reason
(disabled / no model / nothing to do). Client + server validation.
**Acceptance:** editing a cadence persists + takes effect on next poll; run-now
shows a clear reason; component tests cover the controls + the disabled run-now
message.
**Verification:** `npx vitest run --root apps/dashboard` curator component tests;
manual click-through.
**Dependencies:** T10. **Scope:** M.
**Files:** `apps/dashboard/components/curator/*`, `app/curator/*`, tests.

#### Task 12 — Comment debt (D-6/F24)
**Description:** Update the now-false "grooming wall-clock cron retired" comments
(`curator-tick.ts`, `curator-enqueue.ts`, `http.ts`, `grooming-trigger.ts`) and
the `"schedule"` trigger framing.
**Acceptance:** comments match the revived schedule; no stale "retired" claims.
**Verification:** `pnpm run lint`. **Dependencies:** T6, T7. **Scope:** S.

**Checkpoint — PR-1 complete:** `pnpm run lint && pnpm run typecheck && pnpm test`
green; `CHANGELOG.md` updated; manual dashboard verification of both toggles +
both cadences + run-now-on-disabled. **Review with human, then ship + deploy to
the live box** before starting PR-2.

---

## PR-2 — Mechanical rename (after PR-1 merges)

Pure rename, no behaviour change. Each task = find/replace within a subsystem +
green suite. Land in this order to keep types resolving.

- **R1 (L) — `consolidator`→`intake` in core:** the `consolidator/` dir →
  `intake/`; `consolidator-tick.ts`→`intake-tick.ts`; `runConsolidatorTick`→
  `runIntakeTick`; `Consolidator*`/`Consolidation*` types → `Intake*`;
  `store.consolidateInbox`→`runIntakeSweep`; `consolidation-store/-types`→
  `intake-store/-types`; `consolidatorScheduler`→`intakeScheduler`. Update
  `index.ts` exports + all importers. **Verify:** typecheck + core suite.
- **R2 (L) — grooming-sense `curator`→`grooming`:** `curator-tick.ts`→
  `grooming-tick.ts`; `runCuratorTick`→`runGroomingTick`; `CuratorConfig`/
  read/write→`Grooming*`; `curator-chat.ts`→`grooming-chat.ts`,
  `curatorChat`→`groomingChat`; tRPC `curator` router→`grooming` (chat moves in).
  Keep umbrella `curator` (page title, `curator.*` keys, `curator_note`,
  `memory_curation_*`). **Verify:** typecheck + mcp-server suite.
- **R3 (M) — eval package (F2):** `@librarian/consolidator-eval`→
  `@librarian/intake-eval`, `bin: consolidator-eval`→`intake-eval`, dir +
  internal refs; update `pnpm-workspace`/root scripts that name it. **Verify:**
  `pnpm -r build` + the package's tests.
- **R4 (M) — writer flip + dashboard rename:** flip `curator_note.source:
  "consolidator"`→`"intake"` (no shim, F20); rename dashboard tRPC client calls
  (`curator.*`→`grooming.*`, keep `intake.*`) + component/section symbols.
  **Verify:** dashboard suite.
- **R5 (S) — guard + grep-clean:** add the `guards` CI check (`grep -rni
  "consolidator" packages` returns nothing; grooming-sense `curator` symbols
  gone); run it. Update `CHANGELOG.md`. **Verify:** the guard + full suite.

**Checkpoint — PR-2 complete:** Success-Criterion-5 grep clean; full suite +
lint + typecheck green; no behaviour delta vs PR-1.

---

## Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Retiring the per-slice interval gate over-runs grooming | Med | Idempotency already skips unchanged slices (verified F17); add a test that a re-run with no changes makes 0 LLM calls. |
| `isScheduleDue` DST edge | Low | Days-only (no calendar-month math, per the simplification); anchor to local `{time}`; one DST-day unit test; document the rare gap rather than over-engineer. |
| Run-now-on-disabled removes a safety the UI relied on | Low | It's an explicit admin override; LLM-config/token gates stay; clear result reasons (T11). |
| PR-2 rename churn / merge conflicts | Med | Sequenced by subsystem; lands after PR-1; mechanical; guarded by the grep check + green suite at each R-task. |
| Dashboard tRPC contract drift between PR-1 (new fields) and PR-2 (router rename) | Low | PR-1 keeps current router names; PR-2 renames client + server together. |

## Open questions

None blocking. (Spec 045 Open Questions are all resolved.) Plan assumes the
spec's resolved decisions; flag if the two-PR sequencing should change.

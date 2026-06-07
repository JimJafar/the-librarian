# Spec 045 — Curator naming unification + runtime-effective job control

- **Status:** Reviewed (blind code-verification pass applied); all decisions
  resolved — ready for Plan/Tasks
- **Date:** 2026-06-07
- **Lands as TWO PRs** (resolved, post-review):
  - **PR-1 — behaviour** (D-1…D-6): runtime-effective toggles, unconditional
    self-gating schedulers, configurable intake interval + grooming schedule,
    run-now-on-disabled, honest banner. Small, reviewable; ships to the live box
    first.
  - **PR-2 — the mechanical rename** (D-7…D-9): `consolidator`→`intake`,
    grooming-sense `curator`→`grooming`, the `@librarian/consolidator-eval`
    package, the key/string migrations. ~79 files, no behaviour change.
  - Sequencing: PR-1's **new settings keys are already final**
    (`curator.intake.interval_minutes`, `curator.grooming.schedule_*` — the
    `curator.<job>.*` namespace is kept either way). PR-1's **new code symbols
    ride the current names** (e.g. wire the grooming scheduler to the existing
    `runCuratorTick`); PR-2 then renames everything mechanically, including PR-1's
    additions. Keeps PR-2 a pure, behaviour-free rename.
- **Related:** spec 043 (curator unification / inbox cutover), spec 044
  (self-improving curator), ADR 0004 (`propose_memory` → inbox), ADR 0005
  (bounded grooming runs). Motivated by a live incident: enabling **Intake**
  from the dashboard did not start the worker (it needed a server restart).

## Objective

The Librarian's memory curator does **two jobs**, and three layers of the
product disagree on what to call them. The dashboard and settings say
**Intake** / **Grooming**; the code still says **consolidator** / **curator**
— and "curator" is *also* the umbrella name, so it means two things. On top of
the naming drift, the dashboard's enable/disable **toggles don't take effect
without a server restart**, and **Grooming has no scheduler of its own** (it
only runs off the back of Intake), so its toggle and "Run now" button promise
independence the engine doesn't deliver.

This spec does three things in one coordinated change:

1. **Make the toggles real** — flipping Intake or Grooming on/off in the
   dashboard changes behaviour within one tick, no restart.
2. **Give Grooming its own self-gating scheduler** so its toggle is truthful,
   while keeping the post-Intake trigger.
3. **Unify the vocabulary** end-to-end: **Curator** (umbrella) / **Intake** /
   **Grooming**; retire `consolidator` and the grooming-sense of `curator`
   from the code, so the symbols match the settings keys and the UI.

**Success looks like:** an operator toggles a job in the dashboard and sees it
start/stop on the next tick; a contributor greps `intake` or `grooming` and
finds *one* consistent name per job, and `curator` appears as a code symbol
**nowhere**.

## Vocabulary (normative — the single source of truth)

There are exactly **two jobs**, and they are the only first-class names. The
chat ("discuss this memory") is a **Grooming** feature (it proposes grooming
mutations), so it lives there — not under a third bucket.

| Term | Means | Replaces | Used for (code, types, files, tRPC, UI) |
|---|---|---|---|
| **Intake** | job 1 — consolidate new submissions from the inbox | **consolidator** | the inbox sweep (navigate→judge→apply) and everything that drives it |
| **Grooming** | job 2 — tend the existing corpus | grooming-sense **curator** | slice curation (dedup/merge/split/archive) **and the memory chat** |
| **Curator** | the **entity that performs the two jobs** (the umbrella) — not a job, not a code symbol | — | the dashboard page title + the `curator.<job>.*` settings namespace (always read as "the curator's intake/grooming config"). **Never** a function, type, file, tRPC router, or a name for either job. |

**Hard rule:** after this change, **`curator` is never a code construct** — no
`curatorRouter`, no `CuratorConfig`, no `curator-*.ts`, no function or type with
"curator" in it. Every such symbol becomes `intake*` or `grooming*`.
**"consolidator" disappears entirely.** "Curator" persists in exactly two
deliberately-umbrella, non-ambiguous places — the page title and the settings
namespace, where the two jobs are always explicitly named beneath it
(`curator.intake.*`, `curator.grooming.*`). The only place the *old* words
(`consolidation`/`curation`) survive in code is the **canonical event log /
projection** (D-9), an internal persistence detail invisible to users.

## Background — what's there, and the gaps

The engine today (current `main`, post-spec-043):

- **Intake** is `runConsolidatorTick` (a sweep of the inbox) driven by a single
  boot-created `consolidatorScheduler` (`http.ts`), which **only exists if the
  setting was on at boot**. `runConsolidatorTick` self-gates on the LLM config
  but **not** on `curator.intake.enabled`.
- **Grooming** is `runCuratorTick`; it **self-gates** on `curator.grooming.enabled`
  (`curator-tick.ts`) but has **no scheduler** — it runs only via
  `maybeTriggerGroomingAfterIntake` (post-Intake threshold/debounce) or admin
  Run-now.

The eight gaps this spec closes:

1. **Toggle is inert at runtime, both directions.** off→on can't start a `null`
   scheduler; on→off keeps draining because the Intake tick ignores the setting.
2. **Grooming has no independent schedule** — "enable Grooming" with Intake off
   does nothing; the UI implies otherwise.
3. **Grooming's policy keys sit at the umbrella namespace** —
   `curator.default_auto_apply`, `curator.auto_apply_confidence`,
   `curator.interval_minutes` are grooming-only but un-prefixed.
4. **Two enable checks** — `isConsolidatorEnabled` (mcp-server) and
   `isIntakeEnabled` (core) for the same flag.
5. **Boot banner lies** — logs a static `consolidator: on/off` decided at boot.
6. **"Disabled" semantics undefined** — does it also block Run-now?
7. **Toggle latency unstated** — even fixed, a flip bites on the next tick.
8. **`curator.interval_minutes` is vestigial** — "retired as a cadence" by 043
   but still read as the debounce seed.

## The change — decisions

### Runtime job control

- **D-1 — Intake tick self-gates.** `runIntakeTick` (renamed) returns early
  `{ ran: false, reason: "disabled" }` when `isIntakeEnabled(store)` is false —
  byte-for-byte mirroring grooming's existing `if (!config.enabled)` gate. This
  is what makes on→off take effect without touching the scheduler.

- **D-2 — Schedulers are unconditional + self-gating. The on/off toggles
  stay.** Each job keeps its dashboard enable toggle (`curator.intake.enabled` /
  `curator.grooming.enabled`) — that is the user-facing contract and is
  unchanged. "Unconditional" is purely internal: the background timer is **always
  created at boot** (like `backupScheduler` already is), instead of only when the
  job was enabled at boot. Each tick then **reads the enable setting and does
  nothing if the job is off** (a cheap no-op — one settings read). That is what
  makes the toggle take effect at runtime: off→on is noticed on the next tick;
  off keeps it idle. No restart, ever. The boot scan runs unconditionally too
  (self-gates).

- **D-3 — Each job's cadence is dashboard-configurable.** Both jobs get an
  enable toggle **and** their own schedule control, persisted as settings and
  edited on the Curator page:

  - **Intake — "run every *N* minutes."** Setting `curator.intake.interval_minutes`
    (positive int, default `5`). The Intake scheduler sweeps the inbox on this
    cadence (each sweep self-gates on enabled, then drains whatever's queued —
    empty inbox is a cheap no-op). Replaces the hard-coded
    `LIBRARIAN_CONSOLIDATOR_TICK_MS` poll, which becomes a fallback default only.

  - **Grooming — "run every *N* days at *{HH:MM}*."** Settings
    `curator.grooming.interval_days` (positive int, default `1`) and
    `curator.grooming.schedule_time` (24h `HH:MM`, default `03:00`). Default =
    *every 1 day at 03:00* = nightly at 3 AM; weekly = 7, ~monthly = 30 (a
    deliberate **days-only** model — see note). A separate Grooming scheduler
    polls on a fixed internal cadence (~15 min, env-tunable, **not** user-facing
    — just so toggle changes + the due-check are noticed promptly) and runs a
    full pass when due. A new pure helper
    `isScheduleDue(now, lastRunAt, {intervalDays, time})` decides whether a pass
    is due.

    **D-3a — the schedule replaces the per-slice interval gate (resolves the
    F5 collision).** Today the pass selects slices via `selectDueSlices` →
    `isSliceDue` → `isIntervalDue(config.intervalMinutes)` (default 60), so a
    "nightly" pass would still skip any slice groomed in the last hour. That
    per-slice interval gate is **retired**: a *scheduled* (or run-now) pass
    attempts **every** slice, and the existing content **input-hash idempotency**
    (`runCuration` skips a slice whose `computeInputHash` matches a completed run,
    `curator-worker.ts:85-89`) is what skips slices that haven't changed since
    they last groomed. Net: the schedule decides *when* a pass runs; idempotency
    decides *which* slices actually do work; `max_memories` (ADR 0005) bounds
    each. `config.intervalMinutes` and the `isIntervalDue`/`isSliceDue` path are
    removed (this also fully retires `curator.interval_minutes`, see D-8/F23).

    **D-3b — days-only schedule (simplified from days/weeks/months; sidesteps
    F4).** `isScheduleDue` computes the next fire as `lastRunAt`'s local date
    `+ intervalDays` days, anchored at `time` (local). Never-run ⇒ due at the
    next `time`. **Days-only is a deliberate simplification:** it removes the
    calendar-month arithmetic the blind review flagged (JS `setMonth` overflow,
    variable month lengths, the month-end clamp and its tests) — operators express
    "weekly" as 7 and "monthly" as ~30, which is fine for a maintenance job. The
    only residual edge is **DST**: anchoring to local `{time}` keeps 03:00 ≈ 03:00
    across the year; on a spring-forward day a non-existent 03:00 fires on the
    first poll after the clock passes it, and an "already ran this window" guard
    prevents a fall-back double-fire. Unit tests pin the day boundary, the
    interval-days arithmetic, the never-run case, and the DST day.

    The **post-Intake trigger is retained** (threshold/debounce) so a burst of
    new knowledge still grooms *its* slice promptly between scheduled passes;
    both paths converge on `runGroomingTick`, and the same input-hash idempotency
    prevents the two from double-running a slice.

  **Timezone:** the time-of-day gate uses the server's **local time** (the
  container's `TZ`). A `curator.grooming.schedule_tz` picker is a later
  enhancement, out of scope (resolved Q9).

- **D-4 — "Disabled" = no automatic runs; Run-now still works. (BEHAVIOUR
  CHANGE — not current behaviour.)** Today run-now refuses a disabled job in
  *both* routers: intake's `runNow` explicitly returns
  `{ran:false,reason:"disabled"}` when `!isIntakeEnabled` (`trpc/intake.ts:87-91`),
  and grooming's `runCuratorTick` self-gates on `config.enabled`
  (`curator-tick.ts:67`) **before** `bypassSkip` is consulted (`bypassSkip` only
  bypasses input-hash idempotency in `runDueCuration`, not the enable gate). So
  this spec must **move the enable gate out of the run-now path**: the
  scheduled/tick entry self-gates (D-1), but the admin run-now entry passes an
  explicit `manual`/`allowDisabled` flag that skips the enable check (still
  honouring LLM-config/token gates). New tests pin "run-now runs a disabled job;
  the scheduled tick does not."

- **D-5 — One enablement helper.** `isConsolidatorEnabled`
  (`consolidator-config.ts:23`) already just returns `isIntakeEnabled(store)`
  (core). Collapse to the single core helper and update its **three** real call
  sites (F21): `mcp/tools/remember.ts:41`, `mcp/tools/propose-memory.ts:43`, and
  `http.ts:252`. (Earlier draft wrongly implied those already call the core
  helper.)

- **D-6 — Honest boot banner + comment debt.** The banner reports the **live**
  enable state of each job (read at log time). Comments to fix:
  - the stale "enablement is decided by the caller (the http boot)" header in the
    intake tick is removed;
  - **(F22)** the boot warning that legacy `curator.schedule.*` keys are
    "present and ignored; configure `curator.interval_minutes` instead"
    (`http.ts:177-182`, `findLegacyScheduleKeys`) now *contradicts* D-8 (which
    seeds `curator.grooming.schedule_time` / `interval_days` *from* those keys,
    and retires `curator.interval_minutes`). The seed must run **before** any
    notice, and the warning is dropped (or reworded to "migrated to
    `curator.grooming.{interval_days,schedule_time}`");
  - **(F24)** the "grooming wall-clock cron was retired" comments
    (`curator-tick.ts:1-4`, `curator-enqueue.ts:34-38`, `http.ts:216-222`,
    `grooming-trigger.ts:1-2`) and the `"schedule"` trigger default are no longer
    true once D-3 revives a real schedule — update them; `"schedule"` becomes a
    live trigger again.

### Naming unification (rename)

- **D-7 — Code rename, one PR.** Mechanical, no behaviour change:
  - `consolidator/` dir → `intake/`; `consolidator-tick.ts` → `intake-tick.ts`;
    `runConsolidatorTick` → `runIntakeTick`; `Consolidator{Tick,…}` types →
    `Intake*`; `store.consolidateInbox` → `store.runIntakeSweep`;
    `consolidation-store.ts`/`-types.ts` → `intake-store.ts`/`-types.ts`;
    `ConsolidationPlan`/`Outcome`/`applyConsolidationPlan` →
    `IntakePlan`/`IntakeOutcome`/`applyIntakePlan`; `consolidatorScheduler` →
    `intakeScheduler`.
  - grooming-sense `curator` → `grooming`: `curator-tick.ts` →
    `grooming-tick.ts`; `runCuratorTick` → `runGroomingTick`; `CuratorConfig` /
    `readCuratorConfig` / `writeCuratorConfig` / `CuratorConfigPatch*` →
    `Grooming*`. The **chat** moves into grooming too (`curatorChat` →
    `groomingChat`, `curator-chat.ts` → `grooming-chat.ts`) — it's a grooming
    feature. **No** `curator`-named symbol survives; the only retained `curator`
    is the settings-namespace prefix + the page title (see Vocabulary). Shared
    LLM-provider code already lives under `llm.*` (not `curator`) and is
    untouched.
  - **tRPC routers:** exactly two — `intake` (intake ops) and `grooming` (was
    the misnamed `curator` router: config/runs/runNow/dryRun **+ the chat**).
    **No `curator` router.** Dashboard tRPC client calls + component/section
    names follow (`apps/dashboard` is in scope).

- **D-8 — Settings keys + migration (seed-once, no-clobber).** The full
  per-job config namespace after this change:
  - **Intake:** `curator.intake.enabled` (toggle), `curator.intake.interval_minutes`
    (**new**, default `5` — the sweep cadence), plus the existing
    `curator.intake.{provider,model,timeout_ms}`.
  - **Grooming:** `curator.grooming.enabled` (toggle), the **new** schedule pair
    `curator.grooming.interval_days` (default `1`) + `curator.grooming.schedule_time`
    (default `03:00`), `curator.grooming.{max_memories,trigger_threshold,debounce_minutes}`,
    plus the moved policy keys `curator.grooming.default_auto_apply` /
    `curator.grooming.auto_apply_confidence` and the existing
    `curator.grooming.{provider,model,timeout_ms}`.
  - **Migrations** (mirror `migrateCuratorEnablement` — read old, seed new only
    when unset, never clobber). The legacy pre-043 schedule keys map **1:1**:
    - `curator.default_auto_apply` → `curator.grooming.default_auto_apply`
    - `curator.auto_apply_confidence` → `curator.grooming.auto_apply_confidence`
    - legacy `curator.schedule.time` → `curator.grooming.schedule_time`
    - legacy `curator.schedule.interval_days` → `curator.grooming.interval_days`
    - `curator.interval_minutes` is **retired** (its debounce-seed use is already
      migrated); it stops being read.
  - `curator.*` prefix is retained for the umbrella + the two job sub-namespaces
    (resolved decision #4 — namespace only, never a job name).

- **D-9 — Persisted strings: lose "consolidator", keep "curator/curation" as
  the umbrella.** The rename so far is code symbols (no persistence impact).
  Two categories of *persisted* string need a call, and they split exactly along
  your rule:
  - **`"consolidator"` — must go.** The only persisted occurrence is
    `curator_note.source: "consolidator"`, written onto every intake-consolidated
    memory (`consolidator/apply.ts:124`). **Just flip the writer to
    `source: "intake"`.** No read path branches on `curator_note.source` — it's
    stored opaquely (`z.record(z.string(), z.unknown())`,
    `markdown/memory-doc.ts:39`), so flipping the writer breaks nothing and needs
    **no dual-read shim** (F20 — the earlier shim guarded a path that doesn't
    exist). Existing on-disk docs keep the old value until grooming next rewrites
    them; it's inert. *(If you ever want it purged immediately: a one-time vault
    migration over existing docs — bigger churn, not needed. Resolved #7 = leave.)*
  - **`"curator" / "curation"` — kept (umbrella).** `curator_note` (the field
    name), the `memory_curation_runs` / `memory_curation_operations` projection
    tables, the **grooming** `curation-runs.json` sidecar AND the **intake**
    `consolidation-runs.json` sidecar (F19 — there are *two* sidecars; the spec
    earlier conflated them) are the umbrella entity + its action-noun, not the
    word "grooming"/"consolidator" — so they stay. They're append-only/projection
    artifacts where renaming risks existing `events.jsonl`. Code maps them to
    job-named outputs at the read boundary (tRPC returns "intake runs" /
    "grooming runs"). *(Note: `consolidation-runs.json` contains the word
    "consolidation", the action-noun — not "consolidator". If you'd rather rename
    these internal artifacts too, that's a separate event-log migration —
    resolved #8 = leave.)*

### Dashboard UX (the Curator page)

The page keeps its two sections; each gains a schedule control next to its
existing enable toggle and model config. No toggle is removed.

```
Curator
├─ Intake                                   [ Enabled ▣ ]
│   Run every  [  5 ] minutes
│   Model: …            (Run now)   recent runs ▸
│
└─ Grooming                                 [ Enabled ▣ ]
    Run every  [ 1 ] days  at  [ 03:00 ]      ← 1 = nightly · 7 = weekly · 30 ≈ monthly
    Max memories per run: [ 200 ]
    Model: …            (Run now)   recent runs ▸
```

- The **Enabled** toggle gates *automatic* runs only; **Run now** works
  regardless (D-4), and reports a clear reason if it does nothing (disabled /
  no model / nothing to do).
- Editing a schedule takes effect on the next internal poll (≤1 poll), no
  restart — same mechanism as the toggle (D-2).
- Both schedule controls are validated (positive integers; `HH:MM`; unit in
  the allowed set) client- and server-side; `writeGroomingConfig` /
  `writeIntakeConfig` are the single source of truth for the bounds.

## Commands / Project Structure / Testing

**Commands** (unchanged; run from repo root):

```sh
pnpm install --frozen-lockfile
pnpm run lint            # eslint + prettier
pnpm run typecheck       # tsc --noEmit across every workspace
pnpm test                # full vitest suite
pnpm run smoke           # e2e against a real local server
pnpm run healthcheck     # local /mcp + dashboard probes
```

**Project structure** (the rename's footprint):

```
packages/core/src/intake/            ← was consolidator/  (sweep, judge, apply, …)
packages/core/src/intake-tick.ts     ← was consolidator-tick.ts
packages/core/src/grooming-tick.ts   ← was curator-tick.ts
packages/core/src/grooming-config.ts ← was curator-config.ts (CuratorConfig→GroomingConfig)
packages/core/src/store/intake-store.ts / intake-types.ts  ← was consolidation-*
packages/mcp-server/src/bin/http.ts  ← unconditional intakeScheduler + new groomingScheduler
packages/mcp-server/src/trpc/{intake,grooming,curator}.ts  ← curator.ts splits
apps/dashboard/…                     ← tRPC client calls + Intake/Grooming/Curator labels
```

**Testing strategy** (vitest; tests live beside each package in `tests/`):

- **Unit** — `runIntakeTick` returns `{ran:false, reason:"disabled"}` when the
  setting is off (mirror grooming's existing test); `readGroomingConfig` reads
  the migrated keys + defaults; the seed-once migration is idempotent +
  no-clobber.
- **Wiring** — both schedulers are created when `tickMs>0` regardless of the
  boot enable value; a tick on a disabled job is a no-op; Run-now runs a
  disabled job (D-4).
- **Integration** — toggle the setting between two ticks and assert the second
  tick changes behaviour (the runtime-effective contract, both directions).
- **Rename safety** — the full suite (916 core / 168 mcp-server / dashboard)
  stays green; a grep guard asserts `consolidat` and grooming-sense `curator`
  no longer appear in non-event-log source (a lightweight CI `guards` check).

## Code Style

Naming convention, by example — the rule is "one word per job, `curator` =
umbrella only":

```ts
// BEFORE (mixed): the same job under two names
const consolidatorEnabled = isConsolidatorEnabled(store);   // intake
const consolidatorScheduler = consolidatorEnabled ? … : null;
export async function runCuratorTick(…)                     // grooming, but "curator"

// AFTER (canonical):
const intakeScheduler  = intakeTickMs  > 0 ? makeScheduler(runIntakeTick)  : null;
const groomingScheduler = groomingTickMs > 0 ? makeScheduler(runGroomingTick) : null;
export async function runIntakeTick(opts): Promise<IntakeTickResult> {
  if (!isIntakeEnabled(opts.store)) return { ran: false, reason: "disabled" };
  …
}
// No `curator` symbol anywhere — two routers only: intakeRouter, groomingRouter
// (groomingRouter.chat). "Curator" lives only in the page title + the
// curator.intake.* / curator.grooming.* settings namespace.
```

## Boundaries

- **Always:** keep the full suite green at each step; preserve the canonical
  event log untouched (D-9); seed-once/no-clobber every settings migration;
  one self-gate pattern shared by both ticks; update `CHANGELOG.md`.
- **Ask first:** renaming any **persisted** name (event types / projection
  tables / `curation-runs.json`) — that's D-9's deferred sub-decision, not part
  of this PR unless approved; changing default cadences/thresholds.
- **Never:** change the cross-repo plugin contracts (`/handoff`, `/takeover`,
  `/learn`, `/toggle-private`, the memory state model, the handoff shape);
  touch the off-record privacy gate; rewrite event history.

## Success Criteria

1. Toggling **Intake** in the dashboard with the server running: a disabled→
   enabled flip drains the inbox + triggers grooming within one tick; an
   enabled→disabled flip stops draining within one tick. **No restart.** Editing
   `curator.intake.interval_minutes` changes the sweep cadence on the next poll.
2. **Grooming runs a full pass on its configured schedule** —
   *every N days at HH:MM*, default *every 1 day at 03:00* (server-local) —
   independent of Intake; disabling it stops the scheduled pass within one poll;
   the post-Intake trigger still fires when enabled. Unit tests pin
   `isScheduleDue` across the time-of-day boundary, the interval-days arithmetic,
   the never-run case, and the DST day, and that a pass runs at most once per
   window.
3. Admin **Run now** runs either job even when it is disabled (D-4).
4. The boot banner reports each job's **live** enable state.
5. `grep -rni "consolidator" packages` returns **nothing** (the writer flip in
   D-9 means even `source:"consolidator"` is gone from source; the word
   "consolidation" survives only in the event-log artifact names per D-9).
   `grep -rni "curator\|curation" packages` returns **only** umbrella uses — the
   `curator.<job>.*` settings keys, `curator_note`, the `memory_curation_*`
   projections/sidecars, and the "Curator" page title. **No** code symbol, type,
   file, or tRPC router names a *job* "curator" or "consolidator". The `guards`
   CI check enforces it. *(Scope note per F2/F3: this includes the
   `@librarian/consolidator-eval` package if it is in scope — see the scope
   decision below.)*
6. Settings migration: an install with the old un-prefixed keys keeps its exact
   behaviour after upgrade (values seeded into the new keys, no clobber).
7. Full suite green; lint + typecheck clean; dashboard labels read
   Curator / Intake / Grooming consistently.

## Resolved decisions (from review)

1. **Per-job cadences are dashboard-configurable** (D-3). Intake = "every *N*
   minutes" (`curator.intake.interval_minutes`, default 5). Grooming = "every *N*
   **days** at *HH:MM*" (`curator.grooming.interval_days` + `schedule_time`,
   default 1 day / 03:00 = nightly at 3 AM; weekly = 7, ~monthly = 30 — days-only,
   no calendar-month math). The enable **toggles stay** for both jobs —
   "unconditional scheduler" is internal, not a UX change.
2. **D-9 persisted strings** → refined into #7/#8 below: lose the persisted
   `"consolidator"` value (writer flip), keep the `"curator"/"curation"` umbrella names.
3. **Chat home** → the "discuss this memory" chat lives in the **`grooming`**
   router/module (`groomingChat`) — it proposes grooming mutations, so it *is* a
   grooming feature. **No `curator` router is created.** (Revised on review: the
   earlier "umbrella curator router" reintroduced the very ambiguity we're
   removing.)
4. **Curator-name purity** → code is **100% intake/grooming**; "Curator" is
   kept **only** as the dashboard page title and the `curator.intake.*` /
   `curator.grooming.*` settings namespace (always with the job named beneath,
   so never ambiguous). No settings migration of the prefix, no page rebrand.
5. **Toggle latency** → **≤1 poll** is acceptable; the near-instant chokidar
   watcher stays out of scope.
6. **Run-now result clarity** → the dashboard's "Run now" will state a clear
   reason when a run does nothing — **disabled**, **no model configured**, or
   **nothing to do** — rather than a silent no-op. *(Context: because a disabled
   job is still manually run-able (D-4), clicking Run now on a disabled or
   half-configured job needs to say why if it produces nothing. Handled in
   implementation; the reason codes already exist.)*
7. **Persisted `source: "consolidator"`** → **just flip the writer** to
   `source: "intake"`. No dual-read shim is needed (F20 found nothing reads the
   field) and no vault migration; legacy on-disk values are inert.
8. **Internal `curation` names** → **leave** `memory_curation_runs` /
   `curation-runs.json` / `curator_note` as umbrella artifacts (the curator's
   action-noun, not a job name); not job-scoped.
9. **Grooming schedule timezone** → **container `TZ`** (documented); a
   `curator.grooming.schedule_tz` dashboard picker is a later enhancement, out of
   scope. *(Defaulted; say so if you'd rather have the picker now.)*

10. **`@librarian/consolidator-eval` package (F2)** → **rename** to
    `@librarian/intake-eval` (+ `bin: intake-eval`); in scope for PR-2.
11. **One PR vs split (F3)** → **split into two PRs** (PR-1 behaviour, PR-2
    rename — see "Lands as" above).

## Open Questions

None — all resolved (incl. the two scope decisions from the blind review).
Ready for the Plan/Tasks phase (recommended next, scoped to PR-1 first).

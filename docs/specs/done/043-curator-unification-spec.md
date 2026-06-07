# Spec 043 — Curator unification (one curator, two jobs)

**Status:** Draft for review (Specify phase) — **decision-complete / build-ready** (every open
decision settled below; no item makes an autonomous build stop to ask).
**Version target:** MINOR (dashboard + naming + trigger changes behind one-time migrations; both
jobs are opt-in/off by default, so blast radius is small).
**Depends on / composes with:** **042 (2A)** — shares the `curator.intake.*` / `curator.grooming.*`
setting namespace. Recommended order 2A → 2B (2A adds the per-job *model* keys; 2B adds *enablement*
+ *triggers* + the rename); independent enough to land either way, naming stays consistent.
**Relates to:** `docs/research/self-improving-curator-brainstorm.md` — feature **2B**, decisions
**D1 / D2** (and §3.1, §8.1, §8.2). 2C (the self-improving loop) builds on the intake decision log
this spec adds. Synergy with **spec 039** (hub-and-spoke spin-out) for the intake `split`.
**Scope boundary:** server + dashboard only — no plugin changes.

---

## Objective

**What.** Present the two LLM grooming pipelines as **one entity, "the curator," with two jobs** —
**intake** (today's consolidator: reactive, per-submission) and **grooming** (today's curator:
proactive, whole-graph) — and make four concrete changes the unification needs:
- (a) **Retire the nightly grooming cron**; grooming becomes **triggered** (admin-invoked +
  post-intake threshold), never on a wall-clock timer.
- (b) **Add a `split` operation to intake** so an overloaded doc can be spun out at ingestion
  (proposed for review, not auto-applied).
- (c) **One unified dashboard** over both jobs — which requires building the **intake decision log**
  intake lacks today.
- (d) **Rename** the user-facing surfaces to the "curator: intake / grooming" model.

**Why.** Today the two pipelines are split in a way that confuses operators and blocks 2C: grooming
runs on a hidden cron, intake is env-gated with **no decision log and no dashboard**, and the naming
("consolidator" vs "curator") hides that they're one logical curator doing two jobs at different
times (brainstorm §3.1: two *tilings* of one graph, forced by the context window). Unifying the
*presentation, control surface, and observability* — not the business logic — is what D1/D2 asked
for, and it's the substrate 2C's self-improvement loop needs (a logged, dashboard-visible, triggerable
curator).

**Who.** The self-hosting admin. No agent-facing surface changes.

**Success, in one line.** One dashboard shows both jobs' config, enablement, runs, and a "run now";
grooming fires when the admin clicks or when intake has changed enough memories (no cron); intake can
propose a `split`; and every intake decision is logged like grooming's already is.

---

## The load-bearing honesty: "one brain" is conceptual (don't over-merge)

The blind review (brainstorm §11/I1) and this audit agree: the two jobs **share only transport** —
`curator-llm-client.ts`, `curator-redaction.ts`, and the `curator.llm.*` connection
(`consolidator-tick.ts:44-49`, `curator-tick.ts:51-56`) — but have **different hardcoded prompts and
different op schemas**: intake `create|augment|supersede|archive|noop` (`consolidator/judge.ts:63-69`,
prompt `judge-step.ts:43-48`) vs grooming `noop|archive|update|merge|split|create`
(`curator-output.ts:97-112`, prompt `curator-prompt.ts:34-59`), with different context (one
submission + candidates vs a whole slice) and different apply paths (`consolidator/apply.ts` vs
`curator-apply.ts`). **2B unifies naming, control, triggers, and observability — it does NOT merge
the two decision models.** Any "shared ingredient" (a decision log, a `split`) is built once per job,
reusing primitives where they exist. The spec says this so no one tries to collapse the two judges.

---

## Background — what's there (frozen evidence, 2026-06-05)

- **Grooming cron (to retire).** A server timer (`createSerialScheduler`, `http.ts:181-194`,
  `LIBRARIAN_CURATOR_TICK_MS` default 1h) calls `runCuratorTick` (`curator-tick.ts:41-82`), which
  runs **due** slices (idempotency via input-hash skip, `curator-worker.ts:65-74`;
  `curator-schedule.ts`). An **admin `runNow` already exists** (`trpc/curator.ts:50-52`,
  `trigger:"manual"`). The timer is **not** load-bearing on logic — retiring it just removes the
  auto-fire; `runCuratorTick` + due-slice selection stay.
- **Intake schedule (for the post-burst trigger).** Env-gated (`LIBRARIAN_CONSOLIDATOR`,
  `consolidator-config.ts:9-12`); a 5-min sweep timer (`http.ts:217-233`) + a boot sweep
  (`:240-244`) run `consolidateInbox` → `runConsolidatorSweep` (FIFO over the inbox,
  `consolidator/sweep.ts:37-67`, one item via `consolidate.ts:58-94`). The sweep computes a
  `SweepSummary` (counts) — the natural hook for a post-ingestion threshold.
- **Intake op schema is closed, no split** (`consolidator/judge.ts:63-69`); the grooming `split`
  lives in `curator-output.ts:83` + applies in `curator-apply.ts` (~split branch). Intake's apply
  switch (`consolidator/apply.ts:73-150+`) handles create/augment/supersede/archive — a `split`
  branch slots in there.
- **Dashboard + log asymmetry.** Grooming has a `/curator` page (`apps/dashboard/app/curator/page.tsx`,
  config/runs/run-now) + `curatorRouter` (`trpc/curator.ts:25-53`) **and a full per-op decision log**
  (`curation-types.ts:15-76`, sidecar `curation-runs.json`, `createCurationRun`/`recordCurationOperation`
  in `curator-worker.ts:75-118`). **Intake has none** — no page, no tRPC, **no decision log**
  (`consolidate.ts`/`apply.ts` mutate and return an outcome but persist nothing).
- **Available trigger signals (no new instrumentation):** inbox depth (`listInbox`,
  `corpus/inbox.ts:122-128`); active/proposed memory counts (`store.listAll`); and — once PR-1 lands
  — a count of intake ops since the last groom (from the new intake log).

---

## Decisions (settled — build-ready)

Resolves the five audit snags; **nothing here blocks an autonomous build.**

**D-A. Retire the timer; keep due-slice selection; grooming triggers = admin + post-intake
threshold (no wall-clock cron).** Remove the curator `createSerialScheduler` (`http.ts:181-194`).
`runCuratorTick` + due-slice idempotency (`curator-schedule.ts`, input-hash skip) **stay** — a
trigger runs the *due* slices (unchanged slices are skipped, cheap). Triggers: (1) **admin** `runNow`
(exists); (2) **post-intake threshold** — after a consolidator sweep, if ≥ `curator.grooming.trigger_threshold`
memories were created/augmented/superseded/split since the last groom (counted from the PR-1 intake
log), enqueue a grooming run with `trigger:"post_intake"`. **No time-of-day cron** (that's what D1
retires). `curator.interval_minutes` is **repurposed as a debounce floor** — never auto-trigger
grooming more than once per `interval_minutes`, so a long ingestion burst doesn't groom every sweep.
*(Rationale: honours D1's "triggered, not scheduled" while keeping the input-hash idempotency that
makes repeated triggers cheap; the debounce is the only timer-ish concept and it's a rate-limit, not
a scheduler.)*

**D-B. Intake `split` = ingestion-revealed spin-out, always PROPOSED, reusing the split primitive.**
Add `split` to the intake schema/prompt scoped narrowly: when the incoming submission is primarily
about a **distinct entity currently buried inside an overloaded candidate** (the candidate doc is
already in the judge's K=8 — *no navigate change needed*), the judge may propose `split` to spin that
entity out. Intake `split` **always routes to `proposed`** (never auto-applied) regardless of
confidence — intake lacks the whole-slice context grooming has, so a human approves the split.
Factor the existing grooming split into a shared store primitive both apply paths call
(`consolidator/apply.ts` + `curator-apply.ts`). *(Rationale: the owner's "catch overload at ingestion
because ingestion causes it" — D1; pairs with spec 039's hub-and-spoke spin-out; proposing-not-applying
is the honest guard for intake's thinner context. Resolves audit snag #2: the split target is a
retrieved candidate, so navigate is untouched.)*

**D-C. Build the intake decision log (full-outcome), mirroring grooming's — it's 2B scope.** Add a
sidecar `consolidation-runs` store paralleling `curation-runs.json` (run + per-op rows: action,
outcome applied/proposed/skipped/failed, confidence, rationale, source/target ids). Record in
`sweep.ts` + `apply.ts`. **Full coverage** (not just auto-applies) — the dashboard and 2C want the
whole picture, and JSON appends are cheap. **On the perf-sensitive ingestion path the write is
fail-soft** (a logging failure never blocks or fails the sweep). *(Rationale: the unified dashboard
*requires* intake observability; the brainstorm M4 flags this as the prerequisite for grounded
intake feedback in 2C. Building it in 2B keeps 2C focused on the loop, not the plumbing.)*

**D-D. Trigger + threshold config lives in unified `curator.*` settings (2A's namespace).** Grooming
trigger config under `curator.grooming.*` (e.g. `curator.grooming.trigger_threshold`,
`curator.grooming.debounce_minutes` ← the repurposed interval). No separate file, not hardcoded —
one config object, dashboard-edited, consistent with 2A. *(Resolves snag #4.)*

**D-E. Both jobs' enablement moves to dashboard settings; env vars migrate.** Replace `curator.enabled`
→ **`curator.grooming.enabled`** and `LIBRARIAN_CONSOLIDATOR` → **`curator.intake.enabled`** (both
dashboard-editable). One-time migration: read the old setting/env and seed the new key; keep the env
var honoured-with-deprecation-warning for one release. This gives the **one dashboard** control over
**both** jobs and closes the "auto-learn on but consolidator env-off" two-gate confusion (feature-1
blind review I5). *(Resolves snag #5; the env→setting move is the proven `curator.enabled` pattern,
just applied to intake.)*

---

## Plan — increments (one PR each, in order; `main` green at every step)

### PR-1 — Intake decision log (foundational, no behaviour change to filing)
Add the `consolidation-runs` sidecar store (mirror `curation-store.ts`); record a run + per-op rows
in `runConsolidatorSweep` / `consolidator/apply.ts` (full-outcome, **fail-soft** — wrap writes so a
log failure is swallowed and the sweep proceeds). Types mirror `curation-types.ts`. _Accept:_ a sweep
that files N items leaves N logged operations queryable; a forced log-write failure does not fail the
sweep; filing behaviour is byte-identical to before. _Verify: unit + the consolidator suite green._

### PR-2 — Enablement + naming config (D-E + the `curator.*` namespace)
Introduce `curator.intake.enabled` + `curator.grooming.enabled`; migrate `curator.enabled` and
`LIBRARIAN_CONSOLIDATOR` (seed new keys; env honoured-with-warning one release). Gate the two
schedulers/triggers on the new settings. _Accept:_ an install with the old env/setting keeps its exact
enablement after upgrade; toggling either dashboard setting enables/disables that job; the deprecation
warning fires when the env var is still set. _Verify: migration unit tests; smoke on both jobs._

### PR-3 — Retire the grooming cron → triggered (D-A + D-D)
Remove the curator `createSerialScheduler` (`http.ts:181-194`); add the post-intake threshold trigger
(after a sweep, count intake ops since last groom from the PR-1 log; if ≥ threshold and outside the
debounce window, enqueue a `post_intake` grooming run). Add `curator.grooming.trigger_threshold` +
`curator.grooming.debounce_minutes`. _Accept:_ no grooming runs on a wall-clock timer; `runNow` still
works; crossing the threshold after a sweep triggers exactly one grooming run; the debounce suppresses
a second trigger within the window; due-slice idempotency still skips unchanged slices. _Verify: unit
(threshold/debounce); an integration test that a burst of intake ops triggers grooming once._

### PR-4 — Intake `split` (D-B)
Factor grooming's split into a shared store primitive; add `SplitJudgment` to
`consolidator/judge.ts` + the union; document it in `judge-step.ts` (scoped: spin out a distinct
entity from an overloaded candidate); add the apply branch routing split to **proposed**. _Accept:_
intake can emit a `split` that lands as a proposal (never auto-applied); a non-overloaded submission
still never splits (anti-over-fragmentation, cf. spec 039); the shared primitive produces identical
results from both apply paths. _Verify: judge-prompt test pins the split guidance; apply test asserts
proposed-not-applied; the grooming split path is unchanged._

### PR-5 — Unified dashboard (one curator, two jobs)
Add a `consolidator`/intake tRPC router (mirror `curatorRouter`: `config`/`setConfig`/`runs`/
`runOperations`/`runNow`); restructure `/curator` into one page with **Intake** and **Grooming**
sections (each: enablement, config, recent runs, run-now), reading the PR-1 intake log. _Accept:_ both
jobs' config + runs + run-now are visible/operable on one page; intake runs show the PR-1 decisions;
no agent-facing surface is added. _Verify: dashboard component tests + Playwright e2e for both
sections._

### PR-6 — Rename + docs + cleanup
Rename user-facing labels/routes/titles to "Curator — Intake / Grooming"; update env-var docs;
CHANGELOG; retire the dead `classifier` residue if 2A hasn't already (`llm-connection.ts:2-5,54-55`);
remove now-unused cron wiring/comments. _Accept:_ no user-facing "consolidator" label remains (code
identifiers may stay); docs describe the triggered model + the two-job dashboard. _Verify: lint +
docs build; grep for stale "consolidator" user-facing strings._

## Commands / Testing

Standard gate (`pnpm lint/typecheck/build/test`, `smoke`, `healthcheck`); PR-5 also runs the dashboard
Playwright e2e. No secret literals in fixtures (assemble at runtime; AGENTS.md GitGuardian note). Each
PR keeps `pnpm test` green; the curator + consolidator suites must stay green at every step.

## Boundaries

- **Always:** keep the two judges **separate** (one brain is conceptual — don't merge prompts/op
  schemas); intake `split` is **proposed, never auto-applied**; the intake log write is **fail-soft**
  on the ingestion path; migrations preserve existing enablement exactly; one PR per increment, `main`
  green; CHANGELOG.
- **Out of scope:** the self-improvement loop / addendum-as-vault-file / under-evaluation lifecycle
  (2C, D4-D9); the provider/model config (2A); any change to the recall/navigate retrieval; native
  (non-OpenAI-compat) provider APIs; plugin changes.
- **Never:** reintroduce a wall-clock grooming cron (D1 retires it); auto-apply an intake `split`;
  block or fail an intake sweep because logging failed; change the grooming split semantics.

## Success criteria

- [ ] One dashboard page controls + observes **both** jobs (enablement, config, runs, run-now); intake
  runs show per-decision detail from the new log.
- [ ] Grooming runs **only** on admin `runNow` or the post-intake threshold — **never** on a
  wall-clock timer; the debounce prevents repeat triggers; due-slice idempotency still skips unchanged
  slices.
- [ ] Intake can propose a `split` (ingestion-revealed overload); it lands as a proposal, never
  auto-applied; the shared split primitive matches grooming's behaviour.
- [ ] Every intake decision (applied/proposed/skipped/failed) is logged; a logging failure never
  blocks the sweep.
- [ ] `curator.intake.enabled` + `curator.grooming.enabled` control the jobs from the dashboard; an
  existing `curator.enabled` / `LIBRARIAN_CONSOLIDATOR` install keeps its exact enablement after
  migration (with a one-release deprecation warning for the env var).
- [ ] No user-facing "consolidator" naming remains; the two judges' prompts/op schemas are unchanged
  in substance (intake gains only `split`).
- [ ] No plugin touched; recall/navigate untouched; `pnpm test` + smoke + healthcheck + dashboard e2e
  green.

## Notes for 2C (so the loop spec can assume them)

2B leaves 2C these substrates: a **logged** intake (grounded intake feedback — brainstorm M4), a
**triggerable** grooming job (the under-evaluation dry-run, D9, can call `runNow`), and **one
dashboard** to hang the feedback chat + addendum surfaces on. 2C still owns: the addendum-as-vault-file
(D7), the under-evaluation propose-mode lifecycle (D8/D9), and the "discuss this memory" / general
feedback chat (D5).

# Spec 044 — Self-improving curator (the learning loop)

**Status:** Draft for review (Specify phase) — **decision-complete / build-ready** (every D4–D9
decision settled below; eight ordered increments, no blocking open questions).
**Version target:** MINOR (new dashboard chat + addendum lifecycle; addendum moves from a setting to
committed vault files behind a one-time migration; opt-in jobs, small blast radius).
**Depends on:** **2A (042)** — the per-consumer LLM config the chat reuses (`curator.chat.*`); **2B
(043)** — the intake decision log (grounds intake feedback), the *triggerable* grooming job (the
dry-run calls it), and the one dashboard the chat surfaces hang on. Recommended order 2A → 2B → 2C.
**Relates to:** `docs/research/self-improving-curator-brainstorm.md` — feature **2C**, decisions
**D4–D9** (and H1, §4.8–4.11, §11). Synergy: spec 039 (granularity guidance the addendum tunes).
**Scope boundary:** server + dashboard only — no plugin changes.

---

## Objective

**What.** Let the admin teach *this install's* curator by editing its per-job **prompt addendum**
through a dashboard **chat** with the configured curator LLM — safely. Concretely (D4–D9):
- **The addendum becomes two committed vault files** (`<vault>/.curator/intake-addendum.md`,
  `grooming-addendum.md`) → git diff / revert / backup for free (D7), one per job (D6).
- **A dashboard chat** with the curator LLM, entered per-memory ("discuss this memory") or generally
  (memory-less), that can **(a) fix the immediate problem now** and **(b) co-author an addendum edit**
  when the error is structural (D5).
- **Safety = an "under evaluation" lifecycle on real traffic** (D8): an edited addendum is live but
  probationary — everything it produces is forced to `proposed` until the admin **accepts** or
  **rolls back** (git). Plus a grooming **dry-run** over the existing corpus before committing (D9).
- **No automated eval gate** (D4) — the vault has no stable ground truth; the admin judges real
  results, with the 2 KB cap, git revert, and propose-mode as the guards.

**Why.** The shipped prompt is improved by us for everyone; the **addendum** is how one install
learns its owner's preferences and vault quirks (brainstorm §1.5 — "a resident librarian who learns
how *you* like things"). Today there's no way to give that feedback safely: the addendum is a
blind-overwritten setting with no history, no eval, the intake job never even reads it, and there's
no admin path to the LLM. This spec closes that loop with the human as the judge of real results.

**Who.** The self-hosting admin. No agent-facing surface.

**Success, in one line.** The admin clicks "discuss this memory," chats with the curator, fixes the
memory now, and — when it's a recurring error — co-authors an addendum edit that goes under
evaluation (forced to propose on real traffic), reviews its actual effects, then accepts or rolls it
back with a git revert.

---

## The honest guards (what replaces the eval — D4)

There is **no stored pass/fail eval** (D4): generic fixtures measure the wrong target (per-install
tuning) and stored per-install corrections go stale (the vault evolves; recall returns a different
candidate set). The guards are, instead: **(1)** the safety/structural core is re-checked in code
regardless of the addendum (intake `judge` re-validation, grooming `curator-validate`), so an
addendum **can't relax hard rules**; **(2)** the **2 KB cap** forces condense-not-append; **(3)**
**under-evaluation propose-mode on real traffic** (D8) — the admin reviews actual effects, not a
synthetic sample; **(4)** **git revert** of the committed addendum file (D7). The spec states plainly
that this trades the no-regression *guarantee* for a human spot-check of real results — by design.

---

## Background — what's there (frozen evidence, 2026-06-05)

- **Addendum today = one setting, blind-overwritten, intake-blind.** `curator.prompt_addendum`
  (`curator-config.ts:29`, read `:124`), **2 KB cap is a HARD REJECT / throw** (`curator-config.ts:46,148-151`),
  written on every `setConfig` (`:180-181`; `trpc/curator.ts:31-37` blind-overwrites, no history).
  **Grooming consumes it** (`curator-prompt.ts:61-103`, redacted "OPERATOR GUIDANCE" `:89-99`); the
  **live intake sweep does NOT pass it** though the judge accepts the param (`consolidate.ts:71-73`
  omits; `judge-step.ts:67,116` has `promptAddendum?`). **The gap is real.**
- **The vault can hold non-memory committed files.** `vault.writeText(relPath, content)`
  (`vault.ts:52-54`) + a synchronous `commit(message)` per write (`librarian-store.ts:151-153`);
  backup pushes HEAD (`librarian-store.ts:256-266`). A `.curator/*.md` addendum uses the **same**
  write+commit primitive; read-back is `vault.readText` + trim (no frontmatter); diff/revert/history
  are native git. **No new storage machinery needed.**
- **Clean force-propose seams.** Intake routes by confidence band (`consolidator/judge.ts:108-140`)
  then applies (`consolidator/apply.ts:73-121`, propose = `requires_approval:true` `:116`). Grooming
  decides via policy (`curator-apply-policy.ts:30-55`) then `proposeOp`/`applyOp`
  (`curator-apply.ts:108-137`). **Archive wrinkle:** protected archive → `skip` (`:41-42`); `archive`/
  `noop` are "not proposable" and throw (`curator-apply.ts:200-203`) → **under-eval must SKIP
  auto-archives**, not propose them (safe; matches D8).
- **Dry-run substrate exists.** `runNow`/`runCuratorTick` (`trpc/curator.ts:50-52`,
  `curator-tick.ts:41-82`); grooming input is the **replayable** corpus (`curator-evidence` /
  `curator-source-vault`). Intake input (the inbox) is **consumed on apply — not replayable** → no
  intake dry-run (D9: intake stays on D8 new-traffic probation).
- **No admin→LLM chat; no streaming.** The LLM client is server-loop-only (`curator-tick.ts:60-66`,
  `consolidator-tick.ts:54-59`); **all tRPC is request/response, no subscriptions/SSE** (`trpc/`).
  The client already takes a `messages: LlmMessage[]` array and is stateless
  (`curator-llm-client.ts:36-78`) → **reusable for chat**; the caller manages turn history.
- **No merge/split/reverse admin mutations.** `memories` tRPC has create/update/archive/bulkUpdate/
  approve/reject (`memories.ts:152-265`) — **no merge, no split, no reverse**. Merge/split live only
  inside a curation run (`curator-apply.ts:161-172`). **Reverse-a-groom (unmerge) is net-new**
  (detect `curator_note.supersedes` `:214`, unarchive sources, archive target).
- **Proposals + tagging.** Proposals are `status:proposed` (`memories.ts:152-159`), approved/rejected
  (`:224-249`); each memory carries an open `curator_note` object (`curator-apply.ts:213-214`,
  `consolidator/apply.ts:97-102`) → an **`addendum_version` tag is a net-new field there**. No
  "re-evaluate all proposals" batch exists today.

---

## Decisions (settled — build-ready)

**D-1. Two addenda, committed vault files (D6/D7).** `<vault>/.curator/intake-addendum.md` +
`grooming-addendum.md`, written via `vault.writeText` + commit; **version = the file's git commit
hash**. Migration: seed `grooming-addendum.md` from the existing `curator.prompt_addendum` setting,
then retire the setting. Keys for *status* (below) live in settings; the *content* lives in git.

**D-2. Intake reads its addendum (close the I5 gap).** Thread `promptAddendum` through
`ConsolidateInboxItemDeps` → `judgeSubmission` so the live intake sweep consumes
`intake-addendum.md`. (Small, unblocks intake learning.)

**D-3. Under-evaluation lifecycle = a per-job status marker + the committed file (D8).** Each job has
`curator.<job>.addendum_status ∈ {accepted, under_evaluation}` + `curator.<job>.addendum_eval_version`
(the git hash under test), in settings. Editing the addendum writes+commits the file and sets
`under_evaluation`. While `under_evaluation`, the job **forces every op to `proposed`** via a
`forcePropose` flag on both apply paths (auto-applies → propose; **auto-archives → skip**, per the
archive wrinkle). Produced proposals are tagged `curator_note.addendum_version = <hash>`. Admin
actions: **Accept** (status→accepted, auto-apply resumes), **Roll back** (`git checkout` the prior
version of the file, status→accepted), **Re-evaluate proposals** (batch re-judge proposals tagged
with the version — the escape hatch). *No automated gate (D4); the admin judges real results.*

**D-4. Grooming dry-run over the corpus, on demand (D9).** Thread `candidateAddendum?` + a
`dryRun`(=forcePropose) flag through `runCuratorTick` → enqueue → worker; a new `curator.dryRunGrooming`
tRPC runs the candidate over the corpus (or a chosen slice) in propose-mode **without committing it
live**, producing a reviewable batch tagged "from candidate grooming-addendum — dry-run." Offer
**"dry-run this slice"** (fast) vs **"dry-run everything"** (background batch). **Intake has no
dry-run** — it goes straight to D8 probation on new submissions.

**D-5. The chat = request/response (no streaming) for v1.** Each turn is a tRPC mutation
`curator.chat({ messages, memoryId?, job? })` reusing the existing `messages`-array LLM client and
returning the full assistant turn; the dashboard manages turn history. *Streaming/SSE is a deferred
UX upgrade — not worth building subscription infra for v1.*

**D-6. Fix-now = direct admin mutation; addendum-edit = the lifecycle (D5, §4.11).** The two chat
affordances route differently: **fix-now** (merge/split/edit/unmerge a specific memory the admin is
looking at) **applies directly** (the admin already decided in-chat; git is the undo trail) via new
admin mutations (D-7) — it does **not** go through the proposal queue. The **addendum edit** (the
structural lesson) goes through the **under-evaluation lifecycle** (D-3). The chat proposes a
structured action; the admin confirms it with an explicit button — **no autonomous LLM tool-calling
against the live store.**

**D-7. Admin mutation primitives, factored out of the run (I2).** Expose `merge` / `split` / `update`
/ **`unmerge`** as admin tRPC mutations; factor the merge/split/update logic out of `curator-apply.ts`
into shared store primitives both the run path and the admin path call. **`unmerge` is net-new**
(reads `curator_note.supersedes`, unarchives sources, archives the merged target). Admin mutations
tag `curator_note.source = "admin-chat"` for attribution.

**D-8. The chat is the 3rd LLM consumer (§4.10).** Add `curator.chat.{provider,model,timeout_ms}`
(2A's per-consumer scheme), **defaulting to the grooming consumer** when unset. Composes with 2A.

**D-9. Job-picker = infer, then ask (§4.8).** Per-memory chat defaults the target job by inference
from the memory's decision history (grooming ops via `runOperations` filtered by `source_memory_ids`;
intake ops via 2B's log — who last touched it). General (memory-less) chat: the admin picks
intake/grooming when proposing an addendum edit. The chat can always edit **either** addendum.

**D-10. 2 KB cap = condense in-chat, hard backstop at write (M3).** When a co-authored addendum
exceeds 2 KB, the chat asks the curator to **condense** (rewrite tighter, preserving load-bearing
rules) rather than failing; the file write **still hard-rejects > 2 KB** as a backstop. Condense is
lossy → the prompt must instruct preserving still-load-bearing rules.

**D-11. Loop when a job is OFF (I4).** If `curator.<job>.enabled` is false: the chat + addendum
editor still work (edits commit and take effect when the job is enabled), but the under-evaluation
**probation / dry-run are inert** with a clear dashboard message ("this job is disabled — the
addendum applies when you enable it"). Fix-now mutations still work (they're direct store edits, not
job runs).

---

## Plan — increments (one PR each, in order; `main` green at every step)

### PR-1 — Addendum → two committed vault files (D-1)
Read/write `intake-addendum.md` + `grooming-addendum.md` via vault primitives; `setConfig` (addendum
path) writes+commits; expose `readJobAddendum(store, job)` + the current version (git hash). Migrate
`curator.prompt_addendum` → `grooming-addendum.md`; retire the setting. _Accept:_ grooming still reads
its addendum (now from the file); an existing install's addendum survives migration byte-for-byte; the
file is committed + appears in `git log`. _Verify: unit + curator suite green._

### PR-2 — Intake consumes its addendum (D-2)
Thread `promptAddendum` from `intake-addendum.md` through `ConsolidateInboxItemDeps` → `judgeSubmission`.
_Accept:_ a non-empty intake addendum measurably changes the intake prompt (prompt-build test pins it);
empty addendum = today's behaviour. _Verify: consolidator suite green._

### PR-3 — Under-evaluation force-propose + status + tagging (D-3)
Add `forcePropose` to both apply paths (auto-apply→propose; auto-archive→skip); per-job
`addendum_status`/`addendum_eval_version` settings; tag proposals `curator_note.addendum_version`;
Accept / Roll-back (git checkout) / Re-evaluate-proposals batch tRPC. _Accept:_ while `under_evaluation`
every produced op is `proposed` (archives skipped) and tagged with the version; Accept resumes
auto-apply; Roll-back restores the prior file version; Re-evaluate re-judges only that version's
proposals. _Verify: unit (force-propose, archive-skip, accept/rollback) + integration._

### PR-4 — Grooming dry-run over the corpus (D-4)
Thread `candidateAddendum` + `dryRun` through tick→enqueue→worker; `curator.dryRunGrooming` tRPC
(slice or whole-corpus, background for the latter); proposals tagged "dry-run, candidate vN". _Accept:_
a candidate addendum produces a reviewable propose-mode batch **without** becoming live; "dry-run this
slice" returns fast; nothing auto-applies. _Verify: unit + an integration dry-run over a fixture
corpus._

### PR-5 — Admin mutation primitives incl. reverse-a-groom (D-7)
Factor merge/split/update into shared store primitives; add `merge`/`split`/`update`/`unmerge` admin
tRPC mutations (tagged `source:"admin-chat"`); `unmerge` unarchives sources + archives the merged
target via `curator_note.supersedes`. _Accept:_ each mutation works outside a curation run; `unmerge`
restores a bad merge; the run-path apply still uses the same primitives (behaviour unchanged); git
records each as a revertable commit. _Verify: unit per mutation + the grooming apply path unchanged._

### PR-6 — Curator chat endpoint + 3rd consumer config (D-5/D-6/D-8/D-9/D-10 backend)
`curator.chat({messages, memoryId?, job?})` tRPC (request/response) reusing the LLM client; grounds in
the memory + its decision history (D-9 inference); returns either prose or a **structured proposed
action** (a fix-now mutation from PR-5, or an addendum-edit candidate); enforces the 2 KB condense
loop (D-10). Add `curator.chat.*` consumer (default→grooming, D-8). _Accept:_ a chat turn returns a
grounded response; a fix-now suggestion maps to a PR-5 mutation the admin confirms; an addendum
candidate over 2 KB triggers a condense turn, not a hard error; chat uses `curator.chat.*` or falls
back. _Verify: unit with a scripted LLM client (plumbing); real-model is the operator loop._

### PR-7 — Dashboard chat UI + entry points + lifecycle controls (D-5/D-6/D-9/D-11 frontend)
Split-screen chat panel (chat left, addendum draft right, H1); **"discuss this memory"** button on
memory rows (pre-populate id+content+inferred job); a **general** entry (fresh chat, job picker);
Accept / Roll-back / Dry-run / Re-evaluate buttons; job-disabled messaging (D-11). _Accept:_ both
entry points open the chat; fix-now and addendum-edit confirmations call the right endpoints; the
under-evaluation controls drive PR-3/PR-4; a disabled job shows the inert message. _Verify: component
tests + Playwright e2e (per-memory entry, general entry, accept/rollback)._

### PR-8 — Docs + CHANGELOG + surfacing
Document the loop (addendum files, under-evaluation, dry-run, chat); surface each job's addendum
status + version on the unified dashboard; CHANGELOG. _Accept:_ docs describe the human-judges-real-
results model and the guards (D4); the dashboard shows "grooming-addendum vN — under evaluation".
_Verify: docs build; lint._

## Commands / Testing

Standard gate (`pnpm lint/typecheck/build/test`, `smoke`, `healthcheck`); PR-7 runs the dashboard
Playwright e2e. Prompt-affecting changes (PR-2/PR-6) are quality-validated in the operator real-model
loop, not offline (same caveat as the consolidator prompt specs); offline tests pin plumbing with a
scripted LLM client. No secret literals in fixtures (assemble at runtime; AGENTS.md GitGuardian note).
Each PR keeps `pnpm test` green.

## Boundaries

- **Always:** the addendum is **advisory** — hard/safety/structural rules stay code-re-checked
  regardless of it; addendum edits ride the **under-evaluation** lifecycle (never silently
  auto-active); fix-now is an explicit admin-confirmed mutation (no autonomous LLM tool-calling); the
  2 KB cap holds at write; under-eval **skips** auto-archives (archive isn't proposable); git is the
  addendum's history/revert; one PR per increment, `main` green; CHANGELOG.
- **Out of scope:** an automated per-install eval (D4 — explicitly deferred unless drift is
  *observed*); intake dry-run (not replayable — D9); the provider/model refactor (2A); the
  unification/triggers/intake-log (2B — assumed landed); streaming chat (deferred); plugin changes.
- **Never:** let an addendum relax the code-enforced core; auto-apply an addendum edit without the
  under-evaluation pass; auto-apply a fix-now reverse without admin confirmation; exceed the 2 KB cap
  at write; expose any of this to the agent-facing MCP surface.

## Success criteria

- [ ] Each job's addendum is a **committed vault file** (git diff/revert/backup); migration preserves
  the existing addendum exactly.
- [ ] The **intake** job reads its addendum on the live path (the I5 gap is closed).
- [ ] Editing an addendum sets it **under evaluation**: every op it produces is `proposed` (archives
  skipped) and tagged with the addendum version, until the admin **accepts** (auto-apply resumes) or
  **rolls back** (git revert); "re-evaluate proposals" re-judges that version's proposals.
- [ ] **Grooming dry-run** runs a candidate over the corpus/a slice in propose-mode without committing
  it live; **intake** has no dry-run and goes to new-traffic probation.
- [ ] A dashboard **chat** (per-memory + general entry) with the curator LLM can **fix a memory now**
  (incl. **reverse a bad merge**) and **co-author an addendum edit**; fix-now applies directly,
  addendum-edit rides the lifecycle; both require explicit admin confirmation.
- [ ] An over-2 KB co-authored addendum triggers a **condense** turn, not a hard failure; the write
  cap still holds.
- [ ] A **disabled** job's chat/editor still work but probation/dry-run are inert with a clear
  message.
- [ ] No automated eval gate exists (D4); the guards are code-re-check + 2 KB cap + under-evaluation +
  git revert, and the docs say so.
- [ ] No plugin touched; recall/navigate untouched; `pnpm test` + smoke + healthcheck + dashboard e2e
  green.

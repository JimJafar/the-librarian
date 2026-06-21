---
title: Self-improving curator — working doc
status: design-settled (v2, post-review) — C1+assumption resolved (D7/D8); 7 spec-scope items flagged (§11.1)
started: 2026-06-05
---

# Self-improving curator

> Living working doc. §1–§2 are frozen; §3+ are the iteration surface; §10 captures meta-insights.

---

## 1. The question

Can the resident curator learn to groom *this* install's vault the way its owner wants — by proposing
**eval-gated, admin-approved edits to its own prompt addendum** from operator feedback — without (a) drifting
"on vibes," (b) relaxing its safety/structural core, or (c) bloating its prompt? And which of the three
composable pieces — the **self-edit loop**, the **feedback capture**, and the **dashboard chat** — is the
load-bearing minimum that "ships first"?

---

## 1.5 Owner's framing (Guybrush, via TODO.md, design conversation 2026-06-03)

> Give the resident curator the ability to **learn and improve from operator feedback**, the way a Hermes agent
> edits its own SOUL.md. The admin reviews recent grooming, gives feedback — ideally a **chat with the
> configured curator LLM in the dashboard** — and the curator proposes an improvement to its own prompt.

The operator's stated design (most "bones" claimed to already exist):
- **Self-edit only the addendum, never the core.** The judge prompt is two layers — a fixed core contract
  (schema, safety, "untrusted data" framing) that `judge-step.ts` guarantees an injected addendum *can't relax*,
  and a mutable `curator.prompt_addendum` (≤2 KB, in settings). The curator rewrites only the addendum.
- **propose → admin-approve → git commit.** Ride the existing memory-proposal rails; never auto-applied; lands
  as a reviewable, revertable diff (like a SOUL.md edit).
- **Eval-gate every self-edit.** Re-run `@librarian/consolidator-eval` for a proposed addendum, show the
  before/after score delta, allow approval only on no-regression. "Without the eval, the addendum drifts on vibes."
- **Capture structured feedback, not just chat.** 👍/👎 + a note on specific groom decisions; the git history of
  grooms + the admin's labels becomes the "dataset" the curator reasons over. Chat is the discussion layer on top.
- **Learning should condense, not append.** The 2 KB cap forces a *rewrite* into a tighter lesson set, not pile-on.
- **Per-install by design.** Shipped core prompt (`CONSOLIDATOR_PROMPT_VERSION`, improved by us for everyone) vs
  the addendum (this install's curator learning *this* owner's preferences + vault quirks). "A resident
  librarian who learns how **you** like things."
- **Distinct from the retrospective-refactor pass** (reorganises the *vault*); this improves the curator's
  *judgement*. They compose but are separate.
- **Basics ship first.** It's meaty (dashboard chat UI, feedback capture, propose/eval/approve loop, addendum
  versioning).

---

## 2. Audit — what's actually there (2026-06-05)

> Frozen evidence. file:line citations on every concrete claim.

### 2.0 THE load-bearing fact: there are TWO pipelines, and the framing conflates them
- **Curator** (`packages/core/src/curator-*.ts`) — scheduled, slice-based grooming. `CURATOR_PROMPT_VERSION="v2"`
  (`curator-prompt.ts:32`). **Consumes the addendum** (`curator-prompt.ts:61-103`) **and** persists a full
  per-decision log (§2.5). Has the `/curator` dashboard.
- **Consolidator** (`packages/core/src/consolidator/*.ts`) — per-submission inbox judge (create/augment/
  supersede/archive/noop). `CONSOLIDATOR_PROMPT_VERSION="v3"` (`judge-step.ts:27`). **The eval harness
  (`@librarian/consolidator-eval`) tests THIS one** — *not* the curator. Persists **no** decision log; the live
  sweep does **not** pass the addendum (`consolidate.ts:70-73`, though `judge-step.ts:67` accepts the param).

**The mismatch:** the addendum the dashboard edits feeds the **curator**; the eval grades the **consolidator**;
the decision log exists for the **curator** only. **No single pipeline has all three** (addendum + eval + log).
"Eval-gate the addendum edit" does not connect today.

### 2.1 Two-layer prompt; "addendum can't relax core" — PARTLY
Both build `[core] + [evidence] + [OPERATOR GUIDANCE addendum]`, addendum last + "advisory only … cannot
override the rules/schema/apply policy" (`curator-prompt.ts:96`, `judge-step.ts:101`), redacted before send
(`curator-prompt.ts:93`). ≤2 KB cap enforced at write (`curator-config.ts:46,148-152`); stored as setting
`curator.prompt_addendum` (`curator-config.ts:29`). **But the guarantee is downstream *code re-validation*, not
prompt ordering** — "RULES (re-checked in code after you respond — an operation that breaks one is discarded)"
(`curator-prompt.ts:50`; enforced in `curator-validate.ts` / `consolidator/judge.ts`). So the addendum can't
relax the **hard, code-checked** rules — but nothing proves it can't bias the *judgement* in ways the validator
doesn't catch.

### 2.2 Version constant (shipped) vs per-install addendum — TRUE
`CONSOLIDATOR_PROMPT_VERSION` / `CURATOR_PROMPT_VERSION` are shipped-code constants feeding the run hash
(`curator-worker.ts:156`); the addendum is per-install in settings, dashboard-editable
(`config-form.tsx:149-156`). Confirmed.

### 2.3 Proposal rails reusable for an addendum proposal — FALSE (net-new)
`approveProposal` keys on `memory_id` + `status=proposed` (`markdown-memory-store.ts:279-288`); the MCP tool,
tRPC (`trpc/memories.ts:230,246`), and dashboard `/proposals` all key on memory rows. **No generic proposal
entity.** An addendum proposal is net-new (entity + approve path + dashboard surface).

### 2.4 Eval re-runnable on demand w/ candidate addendum → before/after delta — PARTLY
Real + programmatic: `runConsolidatorEval({fixture, llmClient, thresholds})` (`consolidator-eval/src/run.ts:96`)
runs the real navigate→judge→route against an injected client; metrics = filing_accuracy / decision_band /
no_clobber / contradiction_recall / entity_resolution / parse_errors (`metrics.ts:125-139`); fixture
`fixtures/seed-v1.json`; baseline-gate with per-metric delta + 0.05 tolerance (`baseline.ts:63-82`). **Missing:**
no `promptAddendum` param (`run.ts:21-25,86-89`), **no two-run A/B** (compares to a *frozen, uncommitted,
operator-generated* baseline, not two live runs), CLI-driven for real models. Both addendum-injection
(run→judge) and the two-run delta layer are **net-new**.

### 2.5 Per-groom decision record (the "dataset") — PARTLY
**Curator** persists full per-op detail: `operation_type, status, confidence, risk_level, rationale,
proposed_payload, source/target_memory_ids` (`curation-types.ts:62-76`), queryable via `listCurationRuns` +
`getCurationOperations` → tRPC `curator.runs`/`runOperations` (`trpc/curator.ts:40-46`), in sidecar
`curation-runs.json`. **Consolidator persists nothing** (`consolidate.ts:58-90` never records) — only the git
commit of the *outcome* (`librarian-store.ts:243-246`). So the "dataset" exists for the curator, **not** for the
consolidator (the path that actually does create/augment/supersede/archive/noop).

### 2.6 Dashboard curator surface + LLM reachable for chat — PARTLY
`/curator` page (config summary, editable config incl. addendum textarea, run-now, recent-runs) + admin tRPC
`curatorRouter` (`config/setConfig/runs/runOperations/runNow`, `trpc/curator.ts:25-53`). **But the curator LLM
client is server-loop-only** (`curator-tick.ts:61`, `consolidator-tick.ts:54`, eval CLI) — **no admin path can
message the live LLM.** Chat is net-new.

### 2.7 Operator-feedback capture (👍/👎/notes on grooms) — NOT-FOUND
No thumbs/ratings/notes anywhere in `packages/` or `apps/dashboard/`. The premise "learn from operator feedback"
has **no existing capture point**.

### 2.x Bottom line from the audit
- **Real + reusable:** the addendum *slot* (stored, ≤2 KB, redacted, advisory-framed, dashboard-editable) — but
  wired to the **curator** only.
- **The two explicitly-load-bearing bones are NOT pre-built:** (1) a *proof* that a candidate addendum didn't
  weaken the safety core (today it's emergent from framing + downstream re-checks, with no isolated assertion),
  and (2) on-demand eval **A/B with a candidate addendum** (no addendum param, no two-run delta, no committed
  baseline — and it grades the *consolidator*, a different pipeline from the addendum the dashboard edits).
- **Four of seven "bones" are absent or memory-only:** generic proposal entity (2.3), consolidator decision log
  (2.5), admin→LLM chat (2.6), feedback capture (2.7).
- **The framing's "most bones exist" is optimistic.** The addendum mechanism is the one solid bone; the loop
  around it (feedback → propose → eval-A/B → approve), and the pipeline it targets, are mostly to be built.

---

## 3. Reframing

The feature assumed one coherent "curator" with a prompt + an editable addendum + an eval + a decision log. The
audit (§2.0) shows those four ingredients are **scattered across two pipelines**:

| Ingredient | Curator (slice grooming) | Consolidator (inbox judge) |
|---|---|---|
| Editable addendum (`curator.prompt_addendum`) | **wired + consumed** (`curator-prompt.ts`) | param exists, **not wired** (`consolidate.ts:70-73`) |
| Eval harness (`consolidator-eval`) | **none** | **yes** (but tests *this* pipeline) |
| Per-decision log (rationale/confidence) | **yes** (`curation-types.ts`) | **none** |

So the real first question isn't "how does the curator self-improve" — it's **"which pipeline's judgement are we
improving, and how do we get all three ingredients (addendum + eval + decision-log) onto that one pipeline?"**
Three shapes:
- **P1 — target the Curator:** has the addendum + the decision log; **needs a new eval** (the existing one is
  the consolidator's).
- **P2 — target the Consolidator:** has the eval + does the actual create/augment/supersede filing; **needs the
  addendum wired** (cheap — the param exists) **+ a new decision log**.
- **P3 — unify** the two pipelines so there's one learnable judgement surface (biggest, but kills the split that
  caused this).

Everything downstream — where feedback is captured, what the eval grades, what the addendum changes — hangs off
this choice. Second, the "can't relax the core" guarantee (§2.1) is weaker than the framing assumes (downstream
re-checks of *hard* rules, no proof against *judgement* bias) — a self-edit loop needs its own safety guard.

### 3.1 Reframe-of-the-reframe (after §8.1 + §8.2): two *tilings*, one *brain*
The owner pushed to delete the curator (merge happens at ingestion; split can happen at ingestion). §8.2 shows
why that doesn't fully work: the context window forces the graph to be **tiled**, and the consolidator only ever
tiles *locally* (a recall neighbourhood around one new submission) — so **whole-graph restructuring can't happen
at ingestion**. You need a pass that systematically tiles the *whole* graph (the curator's slice approach). So:
- The two pipelines aren't "redundant vs distinct" — they're **two tiling strategies** forced by one constraint:
  **reactive/recall** (consolidator, per submission) and **proactive/slice** (curator, whole graph over time).
  Both are needed; neither subsumes the other.
- But they do the **same *kind* of judgement** (where does this belong; merge/split/archive/supersede) and
  **already share the LLM brain** (`curator-llm-client`, redaction, config). So the thing to unify is **the
  judgement (the prompt/addendum) + the eval + the dashboard + the self-improvement loop — one brain** — *not*
  the two tilings.
- Honours the owner's instincts: **retire the nightly cron** → the whole-graph pass becomes **triggered**
  (admin-invoked / threshold / post-ingestion-burst), not scheduled; **add local `split`** to the consolidator;
  **one unified dashboard** over the whole thing; **one learned addendum feeds *both* prompts** (fixes §8.1's
  latent gap). The whole-graph capability stays, just not as a cron.

→ This makes the self-improving feature target **the shared judgement brain**, applied across both tilings —
which is cleaner than picking P1/P2/P3, and dissolves §2.0's scattered-ingredients problem at the *brain* layer.

---

## 4. Open questions

### 4.1 Which pipeline learns? — **RESOLVED by D1: neither — the shared *judgement brain* learns; both tilings apply it. (Superseded P1.)**
Interim history: audit said keep the curator (§8.1), pointing at P1. The recall-vs-graph audit (§8.2) + the
owner's push then reframed it (§3.1) → D1: two tilings, one self-improving brain. Eval shape for that brain is
the next open question (improvement-process).

### 4.2 Does eval-gating an *addendum* even work? — **MOOT (D4 dropped the stored eval; D8 replaced it with under-evaluation on real traffic).**
The "eval-gate every self-edit" promise requires the eval to run the **same** prompt the addendum modifies. If
the target is the consolidator, the eval must thread the candidate addendum into the run (net-new, §2.4). If the
curator, there is no eval at all yet.

### 4.4 Provider/model config split — open details (D3) — **RESOLVED (all sub-items below).**
- **(b) Embeddings — RESOLVED (Guybrush): stay bundled-local, not a provider consumer.** No API-embeddings option
  exists; keep it local + zero-config.
- **(a) `endpoint` = base URL — RESOLVED (Guybrush): keep the current convention.** It's already a base URL today
  (`curator-llm-client.ts:16` "Base URL, e.g. `https://api.openai.com/v1`"; `:102` appends `/chat/completions`).
  The provider holds `{ base URL, key }`; the chat jobs append the path. No behaviour change.
- **(c) Multiple named providers — RESOLVED (Guybrush):** yes, a dashboard-managed list (add/edit/delete); each job
  picks `{ provider, model }`; mixing across jobs is the point.
- **(d) Model selection — RESOLVED (Guybrush):** dropdown auto-populated from `GET ${endpoint}/models` (uniform under
  OpenAI-compat), free-text fallback.
- **(e) OpenAI-compatible-only — RESOLVED (Guybrush):** no provider `type`; native APIs (e.g. Anthropic `/v1/messages`)
  out of scope; Anthropic via its OpenAI-compat endpoint. *(Caveat to verify at spec/build: the compat shim must
  honour JSON mode `response_format: json_object`, which the curator relies on.)*

### 4.5 Where does the eval fit? — **RESOLVED by D4: no stored eval; a live before/after preview + human approval.**
Both eval flavors fail (generic = wrong target; per-install collection = stale + complex + premature, the vault
won't hold still). Replaced by a live current-state preview the admin judges. *(Rejected: stored eval-collection
of corrections — vault evolution makes the labels stale.)*

### 4.6 Grounded vs freeform chat — **RESOLVED by D5: grounded via the "discuss this memory" button.**
Concrete cases (the memory + the decision-log §2.5), not impressions.

### 4.7 One shared addendum (D1) vs per-job addenda — **RESOLVED by D6: two per-job addenda; admins duplicate cross-cutting guidance manually.**

### 4.8 (Scenario A) Which job does "discuss this memory" target when the admin can't attribute the error?
Options: (a) ask the admin (D5's fork) — but they often can't tell filing-error from grooming-error; (b) the
curator *infers* the responsible job from the memory's history (git/decision log — who last touched it); (c) the
chat covers *both* and the curator decides which addendum (if any) to edit. Likely (b)/(c) > (a).

### 4.9 (Scenario D) The live preview maps to per-submission intake, not per-slice grooming. — **RESOLVED by D8** (under-evaluation propose-mode replaces the preview for both jobs — no slice-preview needed).
Re-running the *grooming* judgement "on this memory" means re-running its slice — expensive, and not a clean
single-memory before/after. Options: preview grooming at the **slice** level (show the slice's before/after
plan); or accept "no clean preview for grooming addendum edits" and lean harder on human judgement there; or
scope grooming previews to "the operations that touched *this* memory."

### 4.10 (Scenario F) The chat/self-improvement is a third LLM consumer — config it.
D3 has intake + grooming consumers; the addendum-authoring chat needs a model too. Reuse the discussed job's
model, or add a third "curator chat" consumer to D3?

### 4.11 (Scenario H) fix-now vs addendum-edit — approval mechanics.
Is the immediate fix applied direct from chat or routed through the proposal flow? Bundled with the addendum
approval or separate? (Two different changes — a memory mutation now + a previewed addendum edit.)

### 4.3 What guards "the addendum can't make the curator worse/unsafe"? — **RESOLVED (D4 + §2.1):**
*unsafe* — the hard rules are re-checked in code regardless of the addendum (§2.1), so a self-written addendum
can't relax the safety/structural core; *worse* — the live before/after preview (D4) + human approval + the
revertable git diff are the guard, with the 2 KB cap limiting blast radius. Accepted for "basics ship first";
revisit only if observed drift demands more (D4).

---

## 5. Working hypotheses

- **H1 (owner, 2026-06-05) — Chat-driven addendum co-authoring — ADOPTED (refined by D4/D5).** A dashboard
  split-screen **chat** (chat left, addendum draft right) where the admin + curator co-author the **addendum**
  (system prompts fixed; preferences + domain subtleties in the addendum). Entry via the **"discuss this memory"
  button** (D5); honesty guard is the **live before/after preview** (D4), not a stored eval. *Still open: per-job
  vs shared addendum (§4.7).* Final loop: **discuss a memory → fix-now + (if structural) propose addendum edit →
  live preview → admin approves → git diff.**

---

## 6. Decisions

**D1 (2026-06-05) — Two tilings, one brain.** The consolidator and curator are kept as **two tiling strategies**
forced by the LLM context window (§8.2) — *reactive/recall* (per submission) and *proactive/slice* (whole graph)
— neither subsuming the other, because whole-graph restructuring can't happen at ingestion (the consolidator
only ever sees a local tile). But they do the **same kind of judgement** and already **share the LLM brain**, so
**the judgement is unified, not the tilings**. Concretely:
- **One judgement brain:** ~~one learned addendum that feeds both tilings~~ *(superseded by D6 → **two** addenda,
  one per job, both wired — fixing the §8.1 gap where the addendum fed only the grooming/curator path)*, one
  **dashboard**, one **self-improvement loop**. This dissolves §2.0's scattered-ingredients problem at the
  *brain* layer. *(Eval → D4: no stored eval, a live preview.)*
- **Retire the nightly curator cron** → the whole-graph pass becomes **triggered** (admin-invoked / threshold /
  post-ingestion-burst), not scheduled. The capability stays; the cron goes.
- **Add `split` to the consolidator** so an overloaded doc can be split at ingestion (owner's idea — overload is
  *caused* by ingestion, so catch it there).

*Rationale:* the context window forces the graph to be tiled either way (§8.2); two tilings are genuinely needed
(reactive local filing + systematic whole-graph review), but unifying the *judgement* (the part that actually
learns) honours the owner's "merge into one thing / no nightly cron / split at ingestion / one dashboard" while
keeping the whole-graph capability. *(Supersedes §4.1's interim "target the curator (P1)" framing — the target
is the shared brain, applied across both tilings.)* *(Eval shape for the unified brain → deferred to the
improvement-process discussion, §4/next.)*

**D2 (2026-06-05) — One entity, "the curator," with two jobs.** Collapse the consolidator + curator into a
single conceptual entity, **the curator** (operator-facing name), which does two jobs at different times, with
different prompts and **optionally different models**:
- **Intake** job — reactive, per-submission, recall-tiled (formerly "the consolidator").
- **Grooming** job — proactive, whole-graph, slice-tiled, *triggered* (formerly the "curator pipeline").
A naming / mental-model simplification (the code's `consolidator/*` + `curator-*` remain the two jobs'
implementations); aligns with D1's "one brain." *(Job names "intake"/"grooming" provisional — rename freely.)*

**D3 (2026-06-05) — Model config = providers + per-consumer model selection (OpenAI-compatible only).** Replace
the single `curator.llm.*` connection with:
- **Named providers** `{ name, endpoint (base URL), key }` (key in the secret store), **managed in the admin
  dashboard** (add / edit / delete) — e.g. one each for OpenAI, Ollama, Anthropic-compat.
- **Per-consumer selection** `{ provider, model }` for **the curator's intake job + its grooming job** (so one
  provider is reused with a different model per job). **Embeddings are NOT a consumer** — they stay the bundled
  local model (no API-embeddings option; keeps zero-config).
- **Model picker:** a dropdown auto-populated from `GET ${endpoint}/models` (the OpenAI-compat list endpoint,
  uniform across providers); **free-text fallback** if a provider doesn't support `/models` or errors.
- **OpenAI-compatible-only** — no provider `type`; the client speaks OpenAI (`/chat/completions`, `Bearer`, JSON
  mode) to every provider (`curator-llm-client.ts:102,131`). **Anthropic is configured via its OpenAI-compat
  endpoint**, not its native `/v1/messages` API. Native provider types are explicitly out of scope.
*A separable config refactor this feature motivates* (the two jobs want different models). §4.4 fully resolved.

**D4 (2026-06-05) — No automated eval gate; a live before/after *preview* + human approval.** There is **no
stable ground truth** for per-install grooming — the vault evolves, so **generic fixtures measure the wrong
target** (per-install tuning) and **stored per-install corrections go stale** (the memory a correction referenced
gets split/archived/grown; recall returns a different candidate set; the right answer is contextual to a moment).
So the self-improvement loop has **no stored pass/fail eval**. ~~Instead a live before/after preview on the
discussed memory.~~ *(Synthetic preview **superseded by D8** — "under-evaluation on real traffic" is a stronger,
real-results guard; and the "revertable git diff" guard was broken, fixed by D7.)* *The admin is the judge.*
Remaining guards: hard rules re-checked in code regardless of the addendum (§2.1); the 2 KB cap forces
condense-not-append; **under-evaluation propose-mode (D8)** + **revertable vault-file versioning (D7)**. The generic `consolidator-eval` stays a dev/release check on the **shipped** prompt —
**not** part of the per-install addendum loop. **Automated per-install eval is explicitly DEFERRED** until/unless
drift is an *observed* problem. *Rationale:* the ground truth is genuinely unstable, so an automated gate fights
the nature of the thing; the human + a concrete live preview is the honest guard, not a compromise. *(Reverses
the TODO's "eval-gate every self-edit" premise — for a real reason, recorded here.)*

**D7 (2026-06-05, resolves §11/C1) — The addendum is a committed file in the vault, not a setting.** Each
per-job addendum is stored as markdown **in the vault** (`<vault>/.curator/intake-addendum.md` +
`grooming-addendum.md`) → git-versioned, so **diff, revert, and backup** (the vault is pushed) come for free —
the real "SOUL.md edit" model the design wanted. Provider keys stay in `settings.json` (secret store); the
addendum (guidance, not a secret) moves into the vault. *Supersedes the `curator.prompt_addendum` setting; fixes
C1's broken "revertable git diff" guard.*

**D8 (2026-06-05, resolves §11's blast-radius assumption + M2/§4.9; supersedes D4's synthetic preview) — Safety =
an "under evaluation" lifecycle on REAL traffic.** An addendum version goes **draft → under-evaluation → accepted
(or rolled back)**. While **under evaluation**, the curator *uses* the new addendum but **forces everything it
produces to `proposed`** (override the apply-policy / confidence-bands to always `propose`) — so the admin reviews
its **actual** effects on real memories in the existing proposal queue, over time, then **accepts** (normal
auto-apply resumes) or **rolls back** (D7's vault versioning). Reuses existing propose paths — both jobs have
them (intake confidence-bands `judge.ts:130-131`; grooming `proposeOp` `curator-apply.ts:115-125`). **Escape
hatch:** "re-evaluate everything in proposals" (batch re-judge) if a prompt produces garbage. *Wrinkle:* grooming
`archive` has no clean propose path (`curator-apply.ts:202`) → under-eval **skips** auto-archives (safe). The
admin takes explicit responsibility (no automated no-regression gate — there's no stable ground truth, D4) — but
judged on **real results**, not a synthetic sample. *(Also resolves §11/M2 + Scenario D: grooming ops are
proposed for review — no slice-preview needed.)*

**D9 (2026-06-05, strengthens D8 for the grooming job) — Grooming addendum edits can be dry-run on demand over
the existing corpus.** Because the grooming job's *input is the existing corpus*, the admin can edit the grooming
addendum and **immediately run a grooming pass over the corpus (or a chosen slice) with the candidate addendum,
forced to propose-mode** — producing a reviewable **batch of proposed operations** (merge/split/update) that show
the addendum's *actual* impact on the real vault, to keep or re-edit. Composes existing pieces: the "run now"
trigger (`trpc/curator.ts`) + the D8 propose-override + the candidate addendum threaded in. **Visualization** =
the existing proposal queue, tagged by addendum version ("from grooming-addendum vN — evaluating"). **Cost/time
scales with corpus size** → offer "dry-run this slice" (fast) vs "dry-run everything" (background batch).
**Intake has no equivalent** — its input is *new submissions*, not replayable — so intake stays on **D8's
new-traffic probation**. *(Inherits D8's `archive` wrinkle — see D8.)*

**D6 (2026-06-05, supersedes D1's "one shared addendum") — Two addenda, one per job.** The **intake** job and
the **grooming** job each have their **own** prompt addendum — *filing* preferences vs *graph-restructuring*
preferences are different concerns a single blob would blur, and the D5 "discuss this memory" fork / job picker
targets one job's addendum. **No shared-section / cross-addendum sync machinery:** if a piece of guidance
genuinely belongs in both, the admin **puts it in both manually** — let admins figure that out rather than
building dedup. Each addendum keeps its own ≤2 KB cap.

**D5 (2026-06-05) — Feedback = a "discuss this memory" button; fix-now always, addendum-edit only when
structural.** A button on a memory opens the curator chat with the memory's **id + content pre-populated**
("I want to chat about this memory you recorded: …"). In the chat the curator can **(a) always fix the immediate
problem** then and there (e.g. merge/edit — a one-off correction), and **(b) only when it's a recurring/
*structural* error** (not a one-off edge case) propose an **addendum edit**. Grounds feedback in concrete cases
(no freeform vibes); the one-off-vs-structural split is the guard against addendum-bloat. *Supersedes the TODO's
"👍/👎 + notes" capture* — the button + chat + the existing grooming decision-log (§2.5) is the richer capture.

*Clarification (Guybrush, 2026-06-05) — the chat also has a **general (memory-less) entry point.*** The
"discuss this memory" button is **one** way in (memory pre-populated); the same curator chat can **also be opened
fresh from the dashboard with no specific memory** for general feedback ("I've noticed you keep over-merging
person memories…"). Same chat surface, same fix-now / addendum-edit affordances; it just starts without a seeded
memory. So the chat is **not** exclusively memory-anchored — the per-memory button is the grounded shortcut, and
the general entry is the catch-all for cross-cutting guidance the admin can't pin to a single memory. *(The
job-picker fork from §4.8 still applies: a general chat may need the admin — or the curator — to choose which
job's addendum, if any, an edit targets, since there's no memory history to infer it from.)*

---

## 7. Loose ends / parking lot

- **"Basics ship first"** (owner) — identify the minimal load-bearing slice (likely the self-edit loop + eval
  gate; chat is a later UX layer).
- **Retrospective-refactor pass** (separate TODO item, under Consolidator) — reorganises the vault (split coarse
  nodes into hub+spokes, merge dups, repair links); *distinct* from this (improves judgement, not the vault).
  They compose; keep separate.

---

## 8. Sub-question deep-dives

### 8.1 "Do we even need the curator?" — audit verdict: KEEP (distinct + load-bearing) (2026-06-05)
The consolidator does **not** subsume the curator. Three structural differences, all load-bearing:
1. **Re-grooms EXISTING memories.** The consolidator only judges *incoming* submissions one at a time and
   **never revisits** a filed memory (`consolidator/sweep.ts:52`, `consolidate.ts:58-93`); the curator's entire
   input is the existing slice corpus (`curator-evidence.ts:170-172`). Only the curator revisits.
2. **`merge` + `split`.** The consolidator's judgment schema is a closed union `create|augment|supersede|archive|noop`
   (`consolidator/judge.ts:63-69`) — **no merge/split**. The curator has them (`curator-output.ts:58-91`,
   `curator-apply.ts:161-177`). Cross-memory reorganisation has **no consolidator equivalent**.
3. **Slice-level reasoning + idempotency** — the curator reasons over a whole slice with an input-hash skip
   (`curator-worker.ts:65-74`); the consolidator's unit is one submission.

**History:** specs are explicit the consolidator was *"built on the **kept** curator pipeline"* (035 §F5,
`docs/specs/035-…:27-28,75`), not a replacement; the curator was still being maintained 2026-06-04. The
**retrospective whole-graph refactor** (TODO) is the curator's *unbuilt* extension, not the consolidator's job.

**Shared machinery (removing the curator frees almost nothing):** the consolidator imports
`curator-llm-client.ts`, `curator-redaction.ts`, and the `curator.llm.*` config (`consolidate.ts:11`,
`judge-step.ts:11-12`, `consolidator-tick.ts:37-41`). Those stay regardless.

**Honest caveat (bears on sequencing):** both pipelines are **off by default** (`curator.enabled` defaults off
`curator-config.ts:114`; consolidator env-gated off `consolidator-config.ts:9-12`), and the curator's headline
payoff (whole-graph retrospective refactor) is still a TODO — so today the curator earns its keep largely as
**scaffolding for a not-yet-shipped capability**.

**Two consequences for the feature:**
- The curator is the right **target** (P1): addendum + decision log + dashboard already there; the gap is an
  **eval** for *this* pipeline (the existing eval is the consolidator's).
- **Latent gap:** the addendum (`curator.prompt_addendum`) feeds the **curator** prompt but the live
  consolidator sweep never passes it (`consolidate.ts:70-73`) — so "how I like things" shapes *grooming* but not
  *filing*. Worth deciding whether one learned addendum should feed **both** prompts (they share the LLM brain).

---

### 8.2 "Why recall, not the graph itself?" — audit answer: the context window forces *tiling* (2026-06-05)
- The judge **never sees the whole vault.** `navigateInbox` (`consolidator/navigate.ts:62-78`) hands it
  **K=8 full candidate bodies** (`DEFAULT_CANDIDATE_LIMIT`, :50, via `recall`) + a **200-entry title-only ToC**
  (`DEFAULT_TOC_LIMIT`, :51, titles+tags, *no bodies*). That's it.
- **The binding constraint is the LLM context window — fundamental, not incidental.** You can't put thousands
  of markdown bodies in one prompt, so the graph **must be tiled**. The consolidator tiles by **recall
  relevance** (a neighbourhood around the new submission); the curator tiles by **ownership slice**
  (`curator-evidence.ts`, ≤200 capped bodies). *Same move, different axis.*
- **Recall is already partly graph-aware.** `recallFromIndex` (`store/index/recall.ts:41-69`) expands **one hop**
  along wikilinks + backlinks (the "co-mention problem" fix, `neighborDecay=0.5`). So "look at the graph" isn't an
  unexplored alternative — it's literally inside recall, just single-hop, re-bounded to K=8.
- **A richer graph-native evidence step is feasible + unblocked but doesn't escape the limit.** The wikilink
  graph is first-class walkable data (`LinkGraph.neighbors/inbound/outbound`, `link-graph.ts:10-17`) the judge
  is never explicitly shown; wiring a backlink neighbourhood / multi-hop walk into `navigate` is feasible — but
  it only changes *which* tile, not the need to tile.

**The consequence that matters:** **whole-graph restructuring cannot happen at ingestion** — the consolidator
structurally only ever sees a *local* tile (one submission's neighbourhood). Covering the *whole* graph
systematically (so every cluster gets a structural review, and orphan dups recall missed get caught) requires a
**separate tiling pass over the whole graph** — which is exactly what the curator's slice approach is. That, not
"it has the prompt," is the real justification for a curator-shaped pass. *(But it need not be a nightly cron —
see §3.1.)*

## 9. Sanity-check: end-to-end scenarios (2026-06-05)

### A — Admin clicks "discuss this memory" on a badly-organised memory ✗ **(which job?)**
The memory looks wrong. But was it **filed** wrong by *intake* or **restructured** wrong by *grooming*? The
admin often can't tell — and D5/D6 require picking which job's addendum to target. **Verdict:** the fork assumes
the admin can attribute the error to a job; frequently they can't. → §4.8.

### B — Memory was filed fine, then grooming merged it badly ⚠
It's a *grooming* error, and "fix it now" must **undo** a grooming merge (split it back out) — a different action
from the intake-side fixes. **Verdict:** works only if (a) the error is attributed to grooming (see A) and (b)
"fix it now" can reverse a prior groom, not just edit the current doc.

### C — Live preview for an *intake* error ✓
Re-run the filing judge on this one memory (current vault) with old vs new intake-addendum → a clean,
single-memory before/after. **Verdict:** the preview maps perfectly to intake (the unit *is* one submission).

### D — Live preview for a *grooming* error ✗ **(preview unit mismatch)**
Grooming judges a **slice** (a whole-graph tile), not one memory. "Preview how grooming would handle *this
memory*" doesn't map — you'd have to re-run the whole slice-groom, which is expensive and isn't a single-memory
before/after. **Verdict:** D4's "preview on the discussed memory" is clean for intake, **awkward for grooming**.
→ §4.9.

### E — Grounding an *intake* error ✗ **(intake has no decision log)**
§2.5: only the grooming job logs its decisions; **intake (the consolidator) logs nothing**. So for an intake
error the chat can show the memory but **not why intake filed it that way** — the D5/§4.6 grounding is
asymmetric. **Verdict:** intake needs a decision log built for "discuss this memory" to be grounded on the
intake side. → build item, but it bites the feedback design.

### F — Which model powers the chat/self-improvement? ⚠
D3's consumers are the **intake job** + the **grooming job**. The "discuss + co-author addendum" chat is a
**third** LLM consumer with no configured provider/model. **Verdict:** config gap — add a third consumer (or
reuse the discussed job's model). → §4.10.

### G — An addendum that passes the single-case preview but biases other cases ⚠
"Always keep family memories granular" fixes this case but would over-fragment other clusters; the single-memory
preview can't show that. **Verdict:** accepted blast-radius limit of D4 — guard is human judgement + revert +
2 KB cap. Real but consciously accepted.

### H — fix-now + addendum-edit: one approval or two? ⚠
The immediate fix is a real mutation (merge/split); the addendum edit is a separate, previewed, approved change.
**Verdict:** mechanics undefined — is fix-now applied direct from chat or via the proposal flow, and is it
bundled with or separate from the addendum approval? → §4.11.

### I — Condense-not-append at the 2 KB cap ⚠
The Nth structural correction forces a rewrite to fit 2 KB; the rewrite may drop a still-load-bearing earlier
rule. **Verdict:** condense is lossy — the curator must be told to preserve load-bearing rules; cap is a feature
but needs care.

### J — Day-one empty addendum ✓
No addendum, no corrections; base behaviour; nothing to diff. Loop is inert until first use. **Verdict:** fine —
the system gets better with use, correct shape.

### K — "discuss" on an already-archived/merged-away memory ⚠
The grooming job already archived/merged it; the id may not resolve to a live doc. **Verdict:** edge case — the
chat must handle "this memory no longer exists as such (it was merged into X / archived)".

### Findings summary
- **Clean:** C (intake preview), J (cold start).
- **Works with notes:** B, G (accepted), H, I, K.
- **Unresolved (✗):** **A** — which job does "discuss this" target when the admin can't attribute the error
  (§4.8). **D** — the live preview is clean for intake but doesn't map to the *slice*-level grooming job (§4.9).
  **E** — intake keeps no decision log, so intake-side feedback is ungrounded. *(All three cluster on the same
  root: the two jobs are genuinely different shapes — per-submission vs per-slice — and the feedback/preview/log
  design was implicitly modelled on the per-submission intake job.)*

---

## 11. Blind review (2026-06-05) — one Critical (C1); not spec-ready until resolved
Independent cold/adversarial review (no conversation context, codebase access, briefed to attack). The audit
(§2/§8) verified strong + accurate; but one **false safety claim is baked into a decision**, plus spec-must-close gaps.

**C1 (CRITICAL) — "revertable git diff like a SOUL.md edit" does NOT exist.** The addendum is a *setting*
(`curator.prompt_addendum`, `curator-config.ts:29,181`) persisted to `settings.json` **outside** the vault git
repo (sidecar JSON, no git — `settings-store.ts:1-7,48-57`; `librarian-store.ts:145-146`); backup is a vault-HEAD
push (`backup/run.ts:6,78`), so settings are never versioned/diffed/backed-up. `setConfig` **blind-overwrites**
(`trpc/curator.ts:31-37`) — the prior addendum is gone, no history, no revert. D4 dropped the eval and leaned the
guard set on "admin-approved, **revertable git diff**"; that guard doesn't exist, leaving only
human-judgment-on-one-preview. → **Fix:** build **addendum versioning** — store each per-job addendum as a
*committed file in the vault* (git diff + revert for free — the real "SOUL.md" model), or rewrite D4's guards
honestly. Changes D4.

**Important:**
- **I1 — "one brain" (D1/D2) is conceptual only.** Two jobs = two hardcoded prompts with *different op schemas*
  (`curator-prompt.ts:41-46` `noop|archive|update|merge|split` vs `judge-step.ts:43-48`
  `create|augment|supersede|archive|noop`); they share only transport. D6 (two addenda) concedes it. Spec must
  state "one brain" buys nothing mechanically — the missing ingredients get built **twice**.
- **I2 — "fix it now" is net-new; reversing a groom has no primitive.** memories tRPC has no merge/split
  (`trpc/memories.ts:152-264`); merge/split live only in the scheduled `curator-apply.ts`; the curator router is
  "deliberately NO consumer-agent surface." Splitting a bad merge back out (Scenario B) exists **nowhere**.
- **I3 — D3 ripples more than "separable."** Both jobs read one shared `curator.llm.*` today
  (`consolidator-tick.ts:34-37`); the addendum is coupled into the same `CuratorConfig` object — splitting
  providers touches the addendum-bearing config. (Stale `classifier` consumer comment in `llm-connection.ts`;
  `classifier-config.ts` doesn't exist — confirm.)
- **I4 — self-improvement runs on jobs OFF by default.** `curator.enabled` off (`curator-config.ts:114`),
  consolidator env-gated off. §9 never asked: if grooming is off there are no grooms / no log / nothing to
  discuss. Spec must define the loop when a job is disabled (inert + dashboard says so).
- **I5 — the live preview is net-new, NOT the eval.** The eval builds a synthetic fixture corpus + never passes
  an addendum (`run.ts:79-89`); D4's preview must call `judgeSubmission` (`judge-step.ts:132`) against the
  *live* vault with old-vs-new addendum — feasible + cheap for **intake**, but new code; the addendum must be
  threaded into the live path (`consolidate.ts:71-74` omits it today).

**Minor:** **M2** — grooming preview (§4.9) genuinely unsolved → the **grooming addendum has no working preview
guard** (half the feature approves blind). **M3** — 2 KB is a hard *reject* (throws, `curator-config.ts:148-152`),
no retry-tighter machinery. **M4** — intake has no decision log → ungrounded intake feedback + a new write on the
perf-sensitive ingestion path. **M5** — doc cites stale trpc paths (real: `packages/mcp-server/src/trpc/`).

**The unexamined assumption:** *a single-case live preview ≈ "the addendum improved judgement generally."* With
no eval + no revert (C1) + no grooming preview (M2), "real learning, not rationalising" reduces to "the admin
approved one before/after." An addendum that fixes the shown case but biases ten unshown ones **passes every
guard**. Honest fix: working revert (C1) + a **multi-case preview** ("show 3 other recent memories under the new
addendum") to widen the blast-radius window; and the spec must *say* it trades the no-regression guarantee for a
human spot-check.

**Verdict:** not spec-ready — resolve **C1** first; **I2 / I4 / M2** close behind.

### 11.1 Resolution status
- **C1** ✅ **resolved by D7** (addendum is a committed vault file → real git diff/revert/backup).
- **Blast-radius assumption + M2 (grooming preview) + §4.9 + Scenario D** ✅ **resolved by D8** (under-evaluation
  on real traffic → propose-mode for both jobs; no synthetic preview; honest "admin takes responsibility").
- **Remaining = spec-scope notes (not design forks):** **I1** "one brain" is conceptual — build ingredients
  twice. **I2** "fix it now" merge/split + **reversing a groom** are net-new admin mutations. **I3** the
  provider/model split touches the addendum-bearing `CuratorConfig` (verify the stale `classifier` consumer).
  **I4** define the loop when a job is **off by default** (inert + dashboard says so). **I5** the under-eval path
  must thread the addendum into the live judge (`consolidate.ts:71-74` omits it). **M3** 2 KB over-cap is a hard
  *reject* — add "condense / retry tighter." **M4** build an **intake decision log** (new write on the
  perf-sensitive ingestion path) so intake-side feedback is grounded. **M5** fix stale trpc paths in citations.

## 10. Late-stage observations

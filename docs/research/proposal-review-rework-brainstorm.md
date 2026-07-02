---
title: Proposal review rework — working doc
status: settled — handed to spec 2026-07-01
started: 2026-07-01
---

# Proposal review rework

> Living working doc. §1-§2 are frozen; §3+ are the iteration surface; §10 captures meta-insights.

---

## 1. The question

The proposal review queue shows the curator's *guess* ("guessed augment") but not
its *plan* — which memory it wanted to touch, what it wanted to add. The admin's
only verbs are Approve (file as new) and Reject (silently archive). Can we make
review (a) informed — show what the curator actually intended; (b) expressive —
let the admin act on that intent or redirect it; and (c) instructive — let a
rejection teach the curator so the same class of extraction stops recurring?

---

## 1.5 Owner's framing (Jim, 2026-07-01)

> "Currently it says what the curator thought it should do (e.g. 'guessed
> augment'). I think there should be more information about what the curator
> wanted to do, and more options on what to do instead. One of the options
> should be to add the memory to a set of examples of things to discard in
> future (or not to extract from auto-captured conversations). Perhaps the
> easiest thing might be to chat live with the curator about a proposal to
> discuss what to do instead if the user does not agree with the original
> suggestion."

Clarifying exchange: "What does 'Approve' mean? That it augments? Augments what?
I'm not shown that am I? And if I discard, is the memory lost?"

---

## 2. Audit — what's actually there (2026-07-01)

> Frozen evidence. Full audit by exploration agent + targeted follow-ups.

### 2.1 The curator's plan exists at judgment time — and is deliberately dropped

The intake judge's output schema (`packages/core/src/intake/judge.ts:21-92`)
carries the complete plan per action:

- `augment`: **required `target_id`** + **`addition`** (the exact text to weave in) + rationale + confidence (`judge.ts:30-36`)
- `supersede`: `target_id` + curated replacement `title`/`body` (`judge.ts:38-45`)
- `create`: curated `title`/`body`/`tags` (`judge.ts:21-28`)
- `split`: `target_id` + ≥2 focused replacements (`judge.ts:69-83`)

On the **propose path**, `proposeSubmission()` (`packages/core/src/intake/apply.ts:145-156`)
files the *raw submission text* with only `curator_note: {source: "intake",
proposed_action, rationale(redacted)}` — the comment is explicit: *"The
judgment's title/target are intentionally dropped — a human (or a later pass)
decides filing from the raw submission, never a low-confidence merge."*
Judgment `confidence` is also not persisted on the proposal.

Grooming's propose path is richer: `grooming-apply.ts:276-306` stamps
`curator_note` with `supersedes` ids, so grooming proposals resolve targets.

### 2.2 The UI is honest about the data loss, not the cause of it

`proposal-action.ts:45-66` (D5 rule): an authoritative badge (Update/Replace/
Merge/Split) appears only when ≥1 resolved target; target-less intake proposals
badge as **"New — needs filing"** with the guessed action as muted text.
`approveConsequenceLabel()` (`proposal-action.ts:75-82`) states replacement
consequences when targets exist. The card shows rationale as an italic quote
(`proposal-card.tsx:108-112`) and a server-rendered diff for single-target
updates (`trpc/memories.ts:250-254`).

### 2.3 Resolution is binary and teaches nothing

- Approve → `store.approveProposal(id, "approve", patch)` → status `active`,
  then archives superseded sources for update/supersede/merge
  (`markdown-memory-store.ts:296-341`). tRPC accepts an optional **patch**
  (`trpc/memories.ts:436-441`) — the UI never uses it.
- Reject → status `archived` (`markdown-memory-store.ts:305-310`). Content is
  NOT lost (archive page; purge is separate + git-recoverable) but is invisible
  to recall, and **no signal reaches the curator**.

### 2.4 The teaching channel already exists: per-job addendum + curator chat

- Addendum: per-job (`intake`/`grooming`) freeform instruction file, 2 KB cap,
  git-committed, appended to the curator prompt at inference time
  (`curator-addendum.ts:59-85`). The only steering mechanism.
- Curator chat (spec 044 D-7, shipped): grounded chat that can return plain
  messages, `proposed_action` (merge/split/update/unmemerge mirroring D5
  mutation shapes), or `addendum_edit` — all human-confirmed, never
  auto-executed (`grooming-chat.ts`, `apps/dashboard/app/curator/actions.ts:228-316`,
  e2e `curator-chat.spec.ts`). A "Discuss this memory" button exists on memory
  cards (`curator-chat.spec.ts:93-106`).
- Prior brainstorm (`self-improving-curator-brainstorm.md` §2.7) found
  structured operator feedback (👍/👎/notes) NOT built; addendum edits via chat
  were the shipped subset.

### 2.5 No discard-example machinery

No negative-example store, no rejection-pattern accumulation. Grep for
discard-example/negative-example/extraction-guideline: nothing. The intake
prompt has one generic principle ("File durable knowledge, not transient
noise", `curator-prompt.ts:62`).

### 2.x Bottom line from the audit

Idea #1 is mostly **plumbing, not capability**: persist what the judge already
produced. Idea #3 is mostly **an entry point, not a feature**: proposal-scoped
grounding for the existing chat. Idea #2 (discard-examples) is the only genuinely
new mechanism, and the prior brainstorm already carved its slot (structured
feedback was deferred; the addendum is the existing sink).

---

## 3. Reframing

The stated problem ("show more, offer more options") bundles three separable
capabilities with different costs:

1. **Persist the plan** (informed review). The D5 honesty rule was compensating
   for data loss. Keep the rule; fix the loss: store the judge's `target_id`,
   `addition`, curated title/body, and confidence in `curator_note` as
   *non-authoritative context*, and render "wanted to augment ‹Memory X› with
   ‹this text›" on the card.
2. **Act on the plan** (expressive resolution). Once the intended target is
   visible, "Approve as the curator intended" (perform the augment/supersede,
   human-confirmed) becomes possible — the exact human-in-the-loop upgrade the
   propose path was designed to await. Also: "Reject + teach".
3. **Teach from rejection** (feedback loop). Where does a discard-example live —
   the 2 KB addendum, or a structured negative-example store retrieved into the
   intake prompt?

Chat-per-proposal is not a fourth capability; it's the *general* escape hatch
that subsumes the long tail of "what to do instead" once 1–2 handle the common
cases with one click.

---

## 4. Open questions

### 4.1 Where do discard-examples live? **RESOLVED → D3** (single curator-distilled sibling document, owner-proposed)

### 4.2 Execute the stale judgment or re-run the curator? **RESOLVED → D2** (execute persisted plan through existing guards)

### 4.3 New chat grounding type or extended parameter? **RESOLVED → D4** (extend existing grounding)

### 4.4 Reject stays silent-archive, teach opt-in? **RESOLVED → D5** (yes)

### 4.5 Backfill old target-less proposals? **RESOLVED → D6** (no)

### 4.6 Retrieval step for examples? **RESOLVED → D7** (no — whole doc inlined, byte-capped)

---

## 5. Working hypotheses

- **H1:** Persist the full intake judgment (target_id, addition/title/body, confidence) in `curator_note` as non-authoritative context.
- **H2:** Per-action resolution affordances on the card, driven by the persisted plan ("Approve as augment of ‹X›", "Approve as new instead", …).
- **H3 (superseded by H6):** Hybrid teaching: structured discard-example store surfaced to the intake judge + addendum for distilled patterns.
- **H6 (promoted → D3):** A SINGLE curator-distilled
  examples document. "Reject & make an example" sends the rejected submission
  (+ optional admin note) to the curator, which returns the *updated whole
  document* — merging/generalizing as needed to stay within its byte cap. Only
  explicitly flagged rejections enter. Refinements proposed: (a) it is a
  *sibling* of the addendum (e.g. `.curator/intake-examples.md`), not folded
  into it — different provenance (case law vs. operator rules) and separate
  byte budgets; (b) same machinery as the addendum (git-committed, capped,
  appended to the intake prompt) so implementation is a near-clone of
  `curator-addendum.ts`; (c) the distilled edit is shown as a diff for one-click
  confirm before commit, preserving the propose-never-execute invariant.
- **H4:** Proposal-scoped chat via extended grounding on the existing curator chat — no new chat system.
- **H5 (leaning reject):** Replace Approve/Reject with a chat-first review flow. Chat is the escape hatch, not the default; one-click resolution must stay for the common case.

---

## 6. Decisions

**D1 (2026-07-01)** — Persist the full intake judgment on the proposal.
`proposeSubmission()` stores the judge's plan in `curator_note`: `target_id`
(as a *guessed*, non-authoritative target), the `addition` text (augment) or
curated `title`/`body` (supersede/create), and `confidence`. Rationale: the
plan already exists at judgment time and is deliberately dropped
(`apply.ts:145-148`); persisting it as descriptive context keeps the D5
honesty rule (no authoritative badge without a *resolved* target) while making
review informed. Confidence rides along (parking-lot item folded in).

**D2 (2026-07-01)** — "Approve as intended" executes the persisted plan through
the existing guards; it never re-runs the curator. Target-exists and no-clobber
(`preservesOriginal`) are checked at approval time; a guard failure downgrades
the affordance with an explanation and offers the proposal-scoped chat instead.
Rationale: deterministic, free, and what the admin saw is exactly what happens;
drift since judgment is exactly what the guards detect. (Owner confirmed.)

**D3 (2026-07-01)** — Teaching is a SINGLE curator-distilled examples document,
a sibling of the addendum. "Reject & make an example" sends the rejected
submission (+ optional admin note) to the curator, which returns the updated
whole document — merging/generalizing to stay within its cap. Only explicitly
flagged rejections enter. Shape: `.curator/intake-examples.md`, git-committed,
byte-capped (4 KB, own settings knob — case law is wordier than rules),
appended to the intake prompt; implementation is a near-clone of
`curator-addendum.ts`. The distilled edit is shown as a diff for one-click
confirm before commit (propose-never-execute invariant). Rationale: owner's
single-document insight subsumes the earlier hybrid — re-distillation naturally
evolves concrete examples into patterns as the doc fills; a sibling file keeps
the operator's hand-written addendum (different provenance, different cadence)
and its 2 KB budget untouched. (Owner: "Agreed - lock it in.")

**D4 (2026-07-01)** — Proposal-scoped chat extends the existing curator chat
grounding (proposal + persisted plan + resolved target + decision-history op);
no new chat system. "Discuss this proposal" button on the card mirrors the
existing "Discuss this memory" entry point. (Owner confirmed.)

**D5 (2026-07-01)** — Reject stays a silent archive; teaching is a separate
explicit affordance. Not every rejection is exemplary — only ones the admin
flags deserve to steer the curator. (Owner confirmed; owner's own framing:
"Not all discarded memories should go there, only ones explicitly flagged as
bad enough to be made an example of.")

**D6 (2026-07-01)** — No backfill of pre-existing target-less proposals; they
keep today's behaviour. (Owner confirmed.)

**D7 (2026-07-01)** — The teach document is inlined into the intake prompt
whole (byte-capped); no retrieval machinery. (Owner confirmed.)

**D8 (2026-07-01, from scenario A)** — Applying the persisted plan CONSUMES the
proposal: mutate the target first, then archive the proposal doc (stamping
`curator_note.resolution: "applied_plan"`) in the same flow. Ordering mirrors
`approveProposal`'s activate-then-archive rule — never a window where the fact
lives nowhere, and never a duplicate active memory. Without this, "Approve as
augment" would both update the target AND activate the proposal as a
standalone doc.

**D9 (2026-07-01, from scenario E)** — Confirming a chat-proposed action from a
proposal-grounded chat also archives the proposal (`confirmActionAction` gains
an optional `proposalId`; on successful mutation the proposal is archived with
`resolution: "resolved_via_chat"`). Otherwise a chat-resolved proposal lingers
in the queue pointing at already-done work.

**D10 (2026-07-01)** — The persisted plan uses NEW additive `curator_note` keys
— `guessed_target_id`, `planned_addition`, `planned_title`, `planned_body`,
`planned_tags`, `confidence` — never `supersedes`. `supersedes` is what the
badge/target-resolution logic treats as authoritative
(`trpc/memories.ts:242-248`, `proposal-action.ts:49`); writing the guess there
would make "guessed augment" render as an authoritative Update and archive the
target on plain approve. Additive wire change, per house preference.

**D11 (2026-07-01, from scenario walk)** — For a proposal carrying a `create`
plan, Approve applies the judge's curated title/body/tags via the approve
mutation's existing (currently unused) `patch` parameter; a secondary "Approve
raw submission" preserves today's behaviour. The judge's curated version was
also being dropped; showing both costs nothing and the patch plumbing already
exists.

---

## 7. Loose ends / parking lot

- Judgment `confidence` is dropped on the propose path — persist it alongside the plan (folded into D1).
- Grooming rejections could also feed a teach loop; v1 scopes teaching to intake (scenario F) — revisit when a grooming rejection actually hurts.
- 👍/👎 on auto-applied intake ops (not just proposals) — the other deferred half of self-improving-curator §2.7; out of scope here.
- Intake eval harness should include the examples doc in its prompt assembly so evals reflect production behaviour — check during build, small.
- Curator chat could gain `examples_edit` (mirroring `addendum_edit`) so recurring patterns can be moved from examples to addendum conversationally — revisit after v1 usage.
- Delete the legacy `guessedAction` fallback rendering once pre-D1 proposals age out of every real queue (see §10.2).

---

## 8. Sub-question deep-dives

*(as needed)*

---

## 9. Sanity-check: end-to-end scenarios (2026-07-01)

### Scenario A — low-confidence augment, admin agrees ✓
- Auto-captured turn → intake judge: `augment`, target ‹Postgres settings›, addition text, confidence 0.6 → below threshold → proposal filed WITH plan (D1/D10).
- Card: "New — needs filing" badge (unchanged, honest) + plan panel: "Wanted to augment ‹Postgres settings› with: ‹…›" + preview diff + confidence.
- Admin clicks "Approve as augment of ‹Postgres settings›" → guards pass (target exists, `preservesOriginal` holds) → target updated, proposal archived with `resolution: applied_plan` (D2, D8).
- **Verdict: clean.**

### Scenario B — target drifted since judgment ⚠
- Same as A, but target was archived (or augment would clobber) between judgment and review.
- Render time: guessed target fails to resolve → plan panel shows "(intended target no longer exists)"; apply-plan affordance disabled with the reason; chat offered.
- Approval time (race): guard re-check fails → error surfaces on the card, no mutation; chat offered. Plain Approve-as-new and Reject remain.
- **Verdict: works-with-notes** — both render-time and approval-time guard paths must exist (approval-time is the authoritative one).

### Scenario C — Reject & make an example ✓
- Admin clicks "Reject & make an example" → dialog: optional note → distill call (curator gets current `intake-examples.md` + rejected submission + note, returns updated whole doc within 4 KB) → diff preview → confirm → doc committed, THEN proposal rejected (archived).
- Cancel at any point = nothing happened (proposal still proposed). Distill LLM failure = error in dialog; plain Reject always available and never blocked (fail-soft house rule).
- **Verdict: clean.**

### Scenario D — the examples doc changes future intake ✓
- Next intake run: prompt = core + examples doc (D7) + addendum. A similar transient submission → judge returns `noop` citing the example → skip verdict → nothing filed, no proposal queue noise.
- **Verdict: clean.** (Eval-harness integration of the examples doc → parking lot.)

### Scenario E — chat redirect ("merge into Y instead") ✓
- "Discuss this proposal" → chat grounded in proposal + plan + guessed target + intake decision op (D4).
- Admin: "this belongs in ‹Y›, not ‹X›" → chat returns `proposed_action` (existing D5 mutation shape) → Confirm → mutation runs, proposal archived via `proposalId` passthrough (D9).
- **Verdict: clean.**

### Scenario F — grooming proposals ⚠
- Already carry authoritative `supersedes` + rationale; informed review already works. Chat button applies (grounding exists). "Reject & make an example" targets the *intake* examples doc — for a grooming rejection the analogous teach loop is out of scope (parking lot); button hidden on grooming-sourced cards in v1.
- **Verdict: works-with-notes.**

### Scenario G — legacy plan-less proposals ✓
- No plan keys in `curator_note` → card renders exactly as today ("guessed augment" muted text); Approve/Reject unchanged; chat available with plan-less grounding. No backfill (D6).
- **Verdict: clean.**

### Scenario H — split proposal group ✓
- Split proposals already record `supersedes`; grouping UI unchanged. Teach + chat affordances available per card.
- **Verdict: clean.**

### Findings summary

**Clean:** A, C, D, E, G, H.
**Works with notes:** B (dual guard layers, approval-time authoritative), F (teach button intake-only in v1).
**Unresolved:** none.

---

## 10. Late-stage observations

### 10.1 The owner's single-document insight beat the engineered hybrid
Re-distillation on every addition gives bounded size AND example→pattern
generalization in one mechanism. The hybrid (store + rotation + addendum) was
solving the same problem with two mechanisms and a policy. Simpler won.

### 10.2 Simplification pass — what the new design obsoletes
- `proposal-action.ts`'s `guessedAction` muted-text mechanism is *demoted*, not
  deleted: it remains the fallback for legacy plan-less proposals (D6), but
  plan-carrying proposals render the plan panel instead. Revisit deleting the
  fallback once pre-D1 proposals age out of every real queue.
- The D5 badge rule survives intact — this design vindicates it (persist more
  data rather than loosen the honesty rule).
- The approve mutation's dormant `patch` parameter finally earns its keep (D11).
- Nothing else became deletable; the change is additive by design.

### 10.3 The propose path was always "awaiting a human" — now the human can say yes to the right thing
The original comment ("a human decides filing from the raw submission, never a
low-confidence merge") framed dropping the plan as safety. The actual safety
property was *don't auto-apply*; dropping the data just made the human's
decision uninformed. Keeping the guardrail while persisting the context is the
whole feature in one sentence.

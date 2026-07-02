# Spec: Proposal review rework — informed, expressive, instructive

**Status:** for review — decision-complete (brainstorm settled 2026-07-01)
**Date:** 2026-07-01
**Journey:** `docs/research/proposal-review-rework-brainstorm.md` (decisions D1–D11, scenarios A–H all resolved)

## Objective

Proposal review today shows the curator's *guess* ("guessed augment") but not
its *plan*, offers only Approve-as-new / Reject, and a rejection teaches the
curator nothing. Three capabilities fix this, in increasing order of novelty:

1. **Informed** — persist the intake judge's full plan (target, addition text,
   curated title/body, confidence), which `proposeSubmission()` currently drops
   on purpose (`packages/core/src/intake/apply.ts:145-156`), and render it on
   the proposal card.
2. **Expressive** — let the admin execute that plan ("Approve as augment of
   ‹X›"), approve the curated version of a create, or open the existing curator
   chat grounded in the proposal to redirect it.
3. **Instructive** — "Reject & make an example": a flagged rejection is
   distilled by the curator into a single bounded examples document that rides
   the intake prompt, so the same class of extraction stops recurring.

The D5 honesty rule (no authoritative badge without a resolved target) survives
unchanged — we persist more data rather than loosen the rule.

## Success criteria (testable)

**F1 — Persist the plan (core)**

1. An intake `augment` judgment routed to propose files a proposal whose
   `curator_note` carries `guessed_target_id`, `planned_addition`, and
   `confidence` (plus existing `source`/`proposed_action`/`rationale`).
   `supersede` persists `guessed_target_id`, `planned_title`, `planned_body`,
   `confidence`; `create` persists `planned_title`, `planned_body`,
   `planned_tags`, `confidence`.
2. `curator_note.supersedes` is untouched by the new keys — a plan-carrying
   intake proposal still badges "New — needs filing" (non-authoritative), and
   plain Approve still archives nothing (D10).
3. Planned text rides through the same redaction as rationale (untrusted model
   output persisted to the vault).
4. Proposals without plan keys (all pre-existing ones) parse, list, and resolve
   exactly as today — no backfill, no migration (D6).

**F2 — Informed card (enrichment + UI)**

5. `memories.proposalsForReview` resolves `guessed_target_id` to
   `{id, title}` and, for augment, builds a preview diff of the target body
   with the addition woven in (same `unifiedMemoryDiff` machinery). An
   unresolvable guessed target returns `guessed_target: null` with a
   machine-readable reason.
6. The proposal card renders a plan panel: "Wanted to **augment** ‹target
   title› with: ‹addition›" (or the supersede/create equivalent), the preview
   diff, and the judgment confidence. A plan-less proposal renders exactly as
   today.

**F3 — Expressive resolution**

7. A plan-carrying augment/supersede proposal shows "Approve as augment of
   ‹X›" / "Approve — replaces ‹X›". Clicking it executes the *persisted* plan
   through the existing guards — target still exists, `preservesOriginal`
   no-clobber for augment — never re-running the curator (D2). On success the
   target is mutated first, then the proposal is archived with
   `curator_note.resolution: "applied_plan"` (D8): one active home for the
   fact, no duplicate, no lingering queue entry.
8. A guard failure (target archived/drifted since judgment) surfaces a teaching
   error on the card, mutates nothing, disables the affordance with the reason,
   and offers the proposal chat. "Approve as new" and "Reject" remain available
   throughout.
9. A create-plan proposal's default Approve applies the judge's curated
   title/body/tags via the approve mutation's existing `patch` parameter; an
   "Approve raw submission" secondary preserves today's behaviour (D11).

**F4 — Reject & make an example**

10. A new sibling document `.curator/intake-examples.md` (git-committed,
    byte-capped by a new `curator.intake.examples_max_bytes` knob, default
    4096) is appended to the intake prompt when non-empty (D3, D7) — same
    mechanics as the addendum (`curator-addendum.ts` is the pattern). The
    intake eval harness assembles its prompt the same way.
11. "Reject & make an example" on a proposal opens a dialog: optional admin
    note → distill call (curator receives the current examples doc + the
    rejected submission + note, returns the updated **whole document** within
    the cap, merging/generalizing as needed) → diff preview → explicit confirm
    commits the doc, **then** rejects the proposal (scenario C ordering).
12. Cancel at any point changes nothing (proposal stays proposed, doc
    unchanged). A distill LLM failure shows a teaching error in the dialog and
    never blocks plain Reject (fail-soft house rule). Plain Reject remains
    silent-archive with no teaching side effect (D5).
13. The examples doc is admin-viewable and rollback-able like the addendum
    (git history is the undo trail).

**F5 — Proposal-scoped chat**

14. Proposal cards gain "Discuss this proposal", opening the existing curator
    chat grounded in the proposal + its persisted plan + the resolved guessed
    target (D4) — no new chat system. Works for grooming-sourced and legacy
    plan-less proposals too (grounding minus the plan).
15. Confirming a chat-proposed action that originated from a proposal-grounded
    chat also archives that proposal with
    `curator_note.resolution: "resolved_via_chat"` (`confirmActionAction`
    gains an optional `proposalId`) (D9). Chat still proposes, never executes.

**Cross-cutting**

16. No new runtime dependency; wire changes are additive only.
17. `pnpm lint` / `typecheck` / `test` green; e2e for the new card affordances
    and the teach dialog; MINOR version bump + dated CHANGELOG entry; docs-site
    reviewing-proposals guide updated in the same PR.

## Scope boundaries

**In:** intake propose-path persistence; proposal enrichment + card plan panel;
apply-plan resolution; create-plan patch approve; the intake examples document
(store, knob, prompt assembly, distill flow, dialog, rollback); proposal-scoped
chat entry point + proposal consumption on chat confirm; tests, docs, release.

**Out:**

- **Grooming teach loop.** "Reject & make an example" is hidden on
  grooming-sourced proposals in v1 (scenario F); revisit when a grooming
  rejection actually hurts.
- **Backfill** of pre-existing target-less proposals (D6).
- **Retrieval machinery** for examples — the whole doc is inlined (D7).
- **Chat editing the examples doc** (`examples_edit` response type mirroring
  `addendum_edit`) — parking lot; the teach dialog is the only writer in v1.
- **👍/👎 on auto-applied intake ops** — the other deferred half of
  self-improving-curator §2.7; separate feature.
- **Re-running the curator at approval time** — rejected (D2): deterministic
  guarded execution of the persisted plan only.
- **Changing the D5 badge rule, `decideApplication`, or any auto-apply
  thresholds** — untouched.

## Decisions (settled — build-ready)

Condensed from the working doc; full rationale there.

- **D1** Persist the judge's full plan (+confidence) in `curator_note` on the
  propose path — the data already exists at judgment time and is dropped.
- **D2** "Approve as intended" executes the persisted plan through existing
  guards; never re-runs the curator. Guard failure → explain + offer chat.
- **D3** Teaching = ONE curator-distilled examples document, a *sibling* of the
  addendum (separate provenance, separate budget), `.curator/intake-examples.md`,
  4 KB cap, near-clone of the addendum machinery, confirm-diff before commit.
- **D4** Proposal chat = extended grounding on the existing curator chat.
- **D5** Reject stays silent-archive; teaching is a separate explicit
  affordance ("only ones flagged as bad enough to be made an example of").
- **D6** No backfill of legacy proposals.
- **D7** Examples doc inlined whole into the intake prompt; no retrieval.
- **D8** Applying a plan consumes the proposal: mutate target, then archive the
  proposal (`resolution: "applied_plan"`) — activate-then-archive ordering.
- **D9** Chat-confirmed actions from a proposal-grounded chat archive the
  proposal (`resolution: "resolved_via_chat"`).
- **D10** Plan keys are NEW additive `curator_note` fields, never `supersedes`
  — keeps badge/target semantics and plain-approve behaviour intact.
- **D11** Create-plan Approve applies the curated version via the existing
  `patch` param; "Approve raw submission" preserves today's path.
- **Naming defaults** (build-ready, no confirmation needed): settings knob
  `curator.intake.examples_max_bytes` (default `4096`); file
  `.curator/intake-examples.md`; tRPC `examples` router mirroring `addendum`
  (`get` / `set` / `rollback`) plus a `distill` mutation; new mutation
  `memories.applyProposalPlan`; `curator_note.resolution` values
  `applied_plan` | `resolved_via_chat`; button copy "Approve as augment of
  ‹X›", "Approve — replaces ‹X›", "Reject & make an example", "Discuss this
  proposal".
- **Dependencies:** none new — curator LLM client, tRPC, store primitives,
  Radix dialog, diff rendering all exist in-tree; no external docs to verify.

## Open questions

None blocking. Empirical gates carried into build, each with a deterministic
fallback:

1. Distill quality (does the curator produce a good merged doc within cap?) —
   verified by the F4 unit/e2e tests with a live-eyeball pass at the end; if
   the whole-document rewrite proves unreliable, fall back to append-example +
   "condense when over cap" (the addendum chat's existing condense-loop
   pattern) without changing the wire surface.
2. Augment preview diff fidelity for odd markdown — verified by snapshot tests;
   if `augmentBody` weaving renders confusingly in the diff, fall back to
   showing the addition as a quoted block without a diff (panel copy
   unchanged).

## Tasks (ordered, vertically sliced)

1. **Persist the plan on the propose path.**
   `intake/apply.ts` + `schemas/memory.ts` (`curator_note` plan keys, additive)
   + redaction of planned text.
   Accept: unit — an augment judgment routed to propose files
   `guessed_target_id`/`planned_addition`/`confidence`; supersede/create
   persist their planned fields; `supersedes` absent; a legacy note without
   plan keys still parses.

2. **Enrich `proposalsForReview` with the plan.**
   Resolve guessed target `{id, title}`; build augment preview diff;
   `guessed_target: null` + reason when unresolvable.
   Accept: unit — plan-carrying row exposes plan + resolved target + diff;
   archived guessed target yields null + reason; legacy rows unchanged.

3. **Plan panel on the proposal card.**
   Accept: component test — plan-carrying proposal renders intent line, target
   title, addition/curated preview, confidence; plan-less proposal renders
   exactly today's card (snapshot).

4. **`memories.applyProposalPlan` + card affordance (augment/supersede).**
   Guards (target exists, `preservesOriginal`), mutate-then-archive (D8),
   `resolution: "applied_plan"`; card button + guard-failure downgrade.
   Accept: unit — augment path updates target body and archives the proposal;
   clobber/missing-target returns a teaching error and mutates nothing;
   component — button disabled with reason when target unresolved.

5. **Create-plan approve-with-patch (D11).**
   Accept: component + unit — default Approve on a create-plan proposal sends
   the curated title/body/tags as `patch`; "Approve raw submission" sends no
   patch; plan-less proposals keep the single Approve.

6. **Examples document core.**
   Read/write/rollback + cap enforcement (clone `curator-addendum.ts` pattern),
   `curator.intake.examples_max_bytes` knob, intake prompt assembly (+ eval
   harness assembly), tRPC `examples.get/set/rollback`.
   Accept: unit — doc appended to intake prompt when non-empty and absent
   otherwise; over-cap set rejected with a teaching error; rollback restores
   prior version as a new commit; eval prompt assembly includes the doc.

7. **Distill + "Reject & make an example" flow.**
   `examples.distill` mutation (curator returns updated whole doc within cap);
   card dialog: note → distill → diff preview → confirm commits doc then
   rejects proposal.
   Accept: e2e — confirm path commits the doc and archives the proposal in
   that order; cancel is a no-op; a distill failure shows an error and plain
   Reject still works; button absent on grooming-sourced cards.

8. **Proposal-scoped chat + consumption on confirm.**
   "Discuss this proposal" button; grounding extended with proposal + plan +
   resolved target; `confirmActionAction` `proposalId` passthrough →
   `resolution: "resolved_via_chat"` (D9).
   Accept: e2e — chat opens grounded in the proposal; confirming a
   chat-proposed action archives the proposal; a fresh non-proposal chat
   confirm archives nothing.

9. **Docs + release.**
   Accept: docs-site reviewing-proposals guide + dashboard/proposals page
   updated (plan panel, new affordances, examples doc + knob documented);
   dated CHANGELOG entry + root `package.json` MINOR bump; `pnpm lint` /
   `typecheck` / `test` green.

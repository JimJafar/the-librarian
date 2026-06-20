# Spec: Make the dashboard proposal queue legible

**Source of truth for *why*:** owner review of the curator before 1.0 (2026-06-20).
**Status:** Draft — owner review pending (checkpoint before build). Scope: `packages/core` + `packages/mcp-server` + `apps/dashboard` + tests + version bump; one cross-repo doc commit (`codeministry`).
**Authored with:** `sdlc-spec`.

---

## 1. Objective

The `/proposals` queue renders every curator proposal as if it were a brand-new note. An admin can't tell a *create* from a *replace* from a *merge*, can't see what a proposal changes, and — the real bug — **approving a replacement leaves the old memory active, creating a duplicate**. Make the queue self-explanatory and make approve do what it says: state the action, show what changes (old→new diff where a target exists), and archive what a replacement replaces.

For: the self-hosting admin working the proposal queue from the dashboard.

## 2. Success criteria (testable)

1. Every proposal card shows an **action badge** derived from `curator_note.proposed_action` per the D5 mapping (which also handles `augment` and the intake/grooming naming split, and badges target-less intake proposals honestly). *Test:* a grooming `update` proposal renders "Update"; an intake `create` renders "New"; an intake `supersede` (no target recorded) renders "New — needs filing", not "Replace".
2. Every card shows a **source chip** (intake / grooming) and the curator's **rationale**. *Test:* both present from `curator_note.source` / `.rationale` for an intake and a grooming proposal.
3. For a single-target replacement (grooming `update`/`supersede`), the card shows **the old memory then the proposed new**, with a unified diff via the existing `DiffView`. *Test:* card contains the target's body and a `DiffView` whose diff has ≥1 `+` and ≥1 `-` line for a changed body.
4. Approving an `update`/`supersede`/`merge` proposal **archives its superseded source(s) atomically**. *Test:* after approving a grooming `update`, the proposal is `active` and its `supersedes` target is `archived` — exactly one active memory remains for that fact; approving a `merge` archives all source ids.
5. Approving a `split` does **not** archive the source; the source is archived only via an explicit follow-up. *Test:* approving one split replacement leaves the source `active`.
6. The Approve button **states the consequence** when sources will be archived. *Test:* button label reads "Approve — replaces 1 memory" for a single-target replace, "Approve — merges 3 memories" for a 3-source merge.
7. An intake `create`/`augment`/`supersede` proposal (no recorded target) renders with badge + rationale + body and **no diff**, and approve activates it unchanged. *Test:* no `DiffView`, no archive side effect on approve.
8. Project-site and README copy describe merge honestly. *Test (manual):* `codeministry/the-librarian/COPY.md` + `index.html` no longer claim all destructive/restructuring ops are proposals; README merge wording confirmed.
9. `pnpm test`, `lint`, `typecheck`, dashboard Playwright e2e, and `check:release` are green.

## 3. Scope

**In:** the `/proposals` queue (create/update/supersede/merge/split proposals from intake and grooming); proposal provenance on `curator_note`; a review-enrichment endpoint; server-side old→new diff reusing `DiffView`; replace-on-approve archival; the merge-policy doc fixes.

**Out:**
- **Merge apply policy** — settled: keep auto-applying (§5, Decision D1). No change to `curator-apply-policy.ts`.
- **Archive proposals** — they are *flags* on the target (`grooming-apply.ts:218-239`, `intake/apply.ts:204-212`), shown in the existing flag-review queue (`resolveFlag`), not on `/proposals`.
- **Numeric curator confidence on the card** — not uniformly available (intake records no `curation_operation`; the memory `confidence` field is the low/med/high enum, not the op's [0,1]). Future: join the audit table.
- **Linking intake create/augment/supersede proposals to a target** — intake intentionally files the raw submission with the target dropped (`intake/apply.ts:146-156`); changing that is a separate curator-quality spec.
- A general memory `get`-by-id endpoint — the review endpoint resolves targets internally.

## 4. Current state & evidence

- Render path: `apps/dashboard/app/(memories)/proposals/page.tsx` → `components/memories/proposals-view.tsx` → `simple-list.tsx` → `memory-card.tsx`. Shows only title, body, agent_id, date, Approve/Reject.
- **Approve doesn't archive the superseded source:** `approveProposal` (`packages/core/src/store/markdown/markdown-memory-store.ts:296-316`) sets `active` + applies patch, never touches `curator_note.supersedes`.
- **Provenance asymmetry:** intake writes `{ source, proposed_action, rationale, supersedes? }` (`intake/apply.ts:137-156`); grooming writes only `{ run_id, supersedes? }` (`grooming-apply.ts:251-268`). `curator_note` persists free-form (`store/markdown/memory-doc.ts:46`).
- **Targets:** grooming `update`/`merge`/`split` and intake `split` record `supersedes` (targets stay active → fetchable); intake `create`/`augment`/`supersede` record none.
- **Reuse:** `DiffView` (`apps/dashboard/components/vault/diff-view.tsx`) renders a unified-diff *string* on the editorial palette — the dashboard's posture is "server makes the diff, client renders it." `humaniseAction` (`apps/dashboard/components/curator/humanise-action.ts`) already maps actions → label/verb/destructive. Store primitives `mergeMemory` / `archiveMemory`.

## 5. Key decisions (settled — build-ready)

- **D1 — Merge stays auto-applying.** Confirmed via `decideApplication` (`curator-apply-policy.ts:39-45`): only `noop`/`forceProposal`/`targetRequiresApproval`/`archive`/`split` are special-cased; merge hits the confidence gate and auto-applies at ≥0.8, archiving sources atomically (`merge-memory.ts:54-60`). Owner decision 2026-06-20. *Consequence:* the only merge work here is honest docs (§ task 5).
- **D2 — Self-describing proposals.** Grooming stamps `source`/`proposed_action`/`rationale` into `curator_note` like intake already does; widen `CuratorNoteSchema` (`schemas/memory.ts:10-18`) to type them (they already round-trip). One read path for the badge, and `proposed_action` is what lets approve distinguish `split` (don't auto-archive) from `update` (do).
- **D3 — Server-side diff via jsdiff, render with existing `DiffView`.** Add `diff` (jsdiff) to `@librarian/core`; a `unifiedMemoryDiff(old, proposed)` helper diffs `\`# ${title}\n\n${body}\`` with `createTwoFilesPatch(...)`. **Strip jsdiff's `Index:` + `===` preamble** so the string matches what `DiffView` already classifies (it dims `---`/`+++`/`@@`/`diff `/`index `, not `Index:`/`===`). *Rationale:* clean body-only diff, no temp files, output is the format `DiffView` parses; pure-JS, server/build-time only — and **`diff@8.0.4` is already in `pnpm-lock.yaml`** (transitive), so declaring it a direct dep of `@librarian/core` adds ~0 install cost. *Verify-then-fallback:* if a new direct dep is unwanted, `git diff --no-index` on body-only temp content via existing git-exec yields the same format — more wiring, no dep.
  - **Dependency citation:** jsdiff `createTwoFilesPatch(oldName, newName, oldStr, newStr, oldHeader?, newHeader?, {context})` → unified-diff string; ESM `import { createTwoFilesPatch } from "diff"`. Source: Context7 `/kpdecker/jsdiff` README + llms.txt (retrieved 2026-06-20). **Use the already-vendored current major: `diff` v8 (`8.0.4`)** — *not* v7 as an earlier draft said. v8 `createTwoFilesPatch` signature confirmed against the docs.
- **D4 — Replace-on-approve, gated by action.** On approve, archive `curator_note.supersedes` only when `proposed_action ∈ {update, supersede, merge}`; idempotent (skip already-archived). `split` excluded (an admin may accept some replacements and reject others — archiving the source on one approval would be premature); the source is archived by an explicit "Archive original" affordance once its replacements are accepted. Proposals with no `supersedes` (intake create/augment/supersede) approve unchanged. *Implementation note:* `approveProposal` currently `void`s its `agent_id` (`markdown-memory-store.ts:302`); thread a real curator/admin actor into the new `archiveMemory` calls, and confirm `archiveMemory` no-ops on an already-archived id (a second merge/split approval may revisit a source).
- **D5 — Action-badge mapping (covers all six `proposed_action` values).** Targeted (carry `supersedes`): `update`→**Update**, `supersede`→**Replace**, `merge`→**Merge**, `split`→**Split**, `create`→**New**. Intake `create`/`augment`/`supersede` carry **no target** (raw submission; `intake/apply.ts:146-156`), so approving them replaces/augments nothing — badge them **New — needs filing** and show the curator's guessed action only as descriptive text, never as an authoritative Update/Replace/Add badge. This reconciles criteria #1 and #7: an authoritative target-implying badge appears **only** when `supersedes` is present (all grooming proposals, and intake `split`).

## 6. Tasks (ordered; each ships independently and leaves the suite green)

- [ ] **T1 — Self-describing grooming proposals** (foundation). `buildCreateCall`/`proposeOp` (`grooming-apply.ts`) write `source:"grooming"`, `proposed_action` (op type), redacted `rationale` into `curator_note`; widen `CuratorNoteSchema`.
      *Accept:* unit — a proposed grooming `update` carries `proposed_action:"update"`, `source:"grooming"`, redacted rationale, `supersedes`; round-trips through `memory-doc`. Intake unchanged (already compliant).
      *Depends:* none.
- [ ] **T2 — Replace-on-approve** (highest-value correctness; risky-early). `approveProposal` archives `supersedes` for `proposed_action ∈ {update,supersede,merge}`, idempotent; not for `split` or no-supersedes.
      *Accept:* integration — approve a grooming `update` → proposal `active`, target `archived`, one active memory remains; approve a 3-source `merge` → all 3 archived; approve a `split` replacement → source stays `active`; approve an intake `create` → no archive.
      *Depends:* T1 (needs `proposed_action`).
- [ ] **T3 — Review endpoint + server diff.** `unifiedMemoryDiff` in core (jsdiff, preamble stripped) + `memories.proposalsForReview` (admin query) returning `{ proposal, action, source, rationale, targets[], diff|null }`; `diff` only when exactly one target; targets resolved via `getMemory`, missing ids skipped fail-soft.
      *Accept:* unit — `unifiedMemoryDiff` returns `+`/`-` lines for a changed body, `""` for identical, no `Index:`/`===` lines; router test — endpoint returns the action/source/rationale + resolved target for a grooming update, `diff:null` for create/merge/split.
      *Depends:* T1.
- [ ] **T4 — Proposal card UX.** Proposal-aware card (replaces bare `MemoryCard` in `proposals-view.tsx`): badge + source chip + rationale (vocabulary from `humaniseAction`); single-target → old + `DiffView` + new; merge → N sources then replacement; split → siblings grouped by `supersedes[0]` (the shared source — `run_id` is grooming-only, absent on intake splits, so it's an optional tiebreaker, not the key) under source; intake no-target → submission + "review and file" note; Approve label states archive consequence; "Archive original" affordance for an accepted split. Run `/impeccable` for on-brand polish.
      *Accept:* component tests per action shape + Playwright — a `replace` shows old+new+diff and approving leaves one active (old archived); a `merge` approval archives all sources; a `create` shows no diff.
      *Depends:* T2, T3.
- [ ] **T5 — Documentation correctness (merge).** *This repo:* re-read README:116/295-299 (auto-apply) and 326-327 (chat) — confirm wording, change only if wrong; grep `installer-cli`/`intake-eval` READMEs + package descriptions for merge claims. *Separate `codeministry` commit:* fix `the-librarian/COPY.md:64-66` and `index.html:121` so merge (confident auto-dedupe that archives sources) isn't lumped under "comes to you as a proposal"; reconcile with `index.html:136`.
      *Accept:* site copy no longer claims all destructive/restructuring ops are proposals; README verified accurate.
      *Depends:* none (parallelizable).
- [ ] **T6 — Release hygiene.** CHANGELOG under a new dated `## [X.Y.Z]` heading + root `package.json` bump (**MINOR** — new endpoint + approve behavior change) + compare-link.
      *Accept:* `pnpm check:release` green; full gate (`test`, `lint`, `typecheck`, e2e) green.
      *Depends:* T1–T4.

## 7. Checkpoint

Owner reviews this spec + task order before build. On approval, hand T1→T6 to `sdlc-implement` (test-first per slice). If scope changes mid-build, update this spec first.

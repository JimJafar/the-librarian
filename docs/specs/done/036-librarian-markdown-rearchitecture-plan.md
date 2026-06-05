# Plan 036 — The Librarian: Markdown Rearchitecture (implementation plan)

**Spec:** `035-librarian-markdown-rearchitecture-spec.md` · **Status:** Draft for review (Plan phase) · **Target:** 1.0.0

Strategy recap: **keep the shell, replace the storage organs.** Breaking storage change → MAJOR. Server-side only (plugin hooks = follow-on specs). Build the new backend *behind the existing interfaces*, reach **parity** on the current verb test-suite, then cut over and migrate — the old SQLite store stays runnable until cutover as the safety net.

**Release shape (decided 2026-05-31):** a single **1.0.0 at the end** (Phase 7) — no earlier dogfood cutover; the markdown backend goes live only once the full build + migration is ready.

---

## Component map (new modules + dependencies)

```
corpus/        markdown I/O · frontmatter (gray-matter) · wikilink parse        → (no deps)
git-ops/ (F12) commit-per-op · link-integrity (rewrite all wikilink forms)      → corpus
index/ (F2)    embed (transformers.js) · keyword (MiniSearch) · wikilink graph
               · file-watcher (chokidar) · namespaces (corpus|references)        → corpus
stores (F1)    MemoryStore + conv-state|handoff|curation|settings on markdown    → corpus, git-ops, index
consolidator/  inbox→file: navigate→judge→edit · supersede · claim · FIFO        → stores, index, git-ops,
  (F5)         (built on the KEPT curator pipeline; classifier removed)            curator-pipeline, eval
verbs (F3/F4/  recall (backlink-aware) · search_references · find/get_skill       → stores, index
  F7/F9)       · handoffs · store/submit
endpoints      learn (F8) · session-start manifest (F6)                          → stores, proposal flow, LLM
dashboard(F10) file-manager · diff review · consolidation feed · manual merge    → stores, git-ops, tRPC
migration(F11) seed import + replay active→inbox; proposed→queue; archived→arch   → stores, consolidator
```

---

## Phased build order

**Phase 0 — Seal the seam (F0).** *Pure refactor on the existing SQLite store; behaviour unchanged; suite stays green.* Narrow `LibrarianStore` (drop public `db`/`eventsPath`/`readEvents`/`rebuildIndex`); refactor tRPC `memories`/`handoffs` off raw rows; **remove `domain-resolution` + the `domains` store** (D16). *Checkpoint:* `typecheck` + full suite green; no raw `store.db`/SQL outside the storage layer.

**Phase 1 — Corpus + git foundation (corpus, F12).** Markdown I/O, frontmatter schema, wikilink parse; the git-ops + link-integrity service (commit-per-op; rewrite `[[x]]`/`[[x|alias]]`/`[[x#h]]`/`![[embed]]`). *Checkpoint:* unit suites — frontmatter round-trip, all wikilink-form rewrite, archive=move-reversible; the `check:no-secrets-in-vault` guard lands here.

**Phase 2 — Markdown-backed stores (F1).** Implement `MemoryStore` + conv-state/handoff/curation/settings on corpus+git+index, wired behind `LibrarianStore`. *Checkpoint — the parity gate:* the **existing (storage-agnostic) verb tests pass on the new backend**; `remember` produces a markdown file + a commit.

**Phase 3 — Index + recall (F2, F3, F4).** Hybrid index (embed/keyword/wikilink), chokidar incremental re-embed (add/change/move/unlink), corpus|references namespaces; backlink-aware `recall`; `search_references`; reference tier. *Checkpoint:* delete `.index/` → `reindex` → equivalent hits (disposability); **S2** (Sophie+Anna retrievable from both) and **S8** (references don't pollute Tier-1) pass; retarget `check:storage-fixture` → corpus-fixture.

**Phase 4 — Consolidator + eval (F5).** *The differentiator — biggest phase.* Inbox pipeline (atomic claim, serial FIFO, boot-scan + chokidar + 5-min tick); navigate (candidates + ToC map) → judge (augment/create/supersede/archive, confidence band) → minimal-edit + wikilinks; built on the kept curator pipeline; **classifier worker removed**. Ship the **consolidator-eval harness + first baseline** alongside. *Checkpoint:* S1/S2/S4/S12/S18 fixtures pass; eval baseline recorded; regression gate wired into CI.

**Phase 5 — Loop + skills (F6, F7, F8, F9).** Skills as `SKILL.md`(+resources) with `find_skills`/`get_skill`; session-start manifest endpoint; `learn` endpoint (transcript → server extraction → proposals; strip-and-send privacy defence); markdown handoffs (5 headings preserved). *Checkpoint:* S9 (`learn`→proposals, off-record dropped), S15 (author skill → manifest → get).

**Phase 6 — Dashboard (F10).** File-manager (tree + folder view; create/edit/rename/move-via-menu/archive); diff-based proposal review; auto-consolidation review feed (G3); manual merge (G4); logs-view → git history; analytics retired/rebuilt. *Checkpoint:* S10 (review/revert), S16 (rename rewrites links), S17 (archive leaves recall).

**Phase 7 — Migration, backup, cutover + release (F11, A8).** Migration tool (seed import → replay active→inbox; proposed→queue; archived→`archive/`; idempotent manifest); `git push` backup + minimal settings/secret backup; **retire** the v0.4.0 bundle/restore-staging machinery + S3 target; remove dead SQLite code + old guards; data cutover; **1.0.0 release** per `docs/release.md`. *Checkpoint:* S11 (migrate real `data/` → sane corpus, idempotent re-run); smoke + healthcheck green on the markdown backend; CHANGELOG + release.

---

## Parallelism
- Phase 0 (seam) and Phase 1 (corpus/git-ops) are independent → parallel.
- Within Phase 3, index and recall split once the corpus module exists.
- Phase 6 (dashboard) can proceed alongside Phase 4 (consolidator) once Phases 2–3 land (stores + index + verbs exist).
- Phases 4 and 5 partly overlap (5's endpoints need stores+proposal flow, not the consolidator).

## Risks → mitigations
- **Consolidator quality** (differentiator risk) → eval harness + baseline built *in* Phase 4, not after; safety nets (review feed, git revert, manual merge) keep the bar pragmatic.
- **Edit-drift / clobber** → minimal-edit/patch prompting + git-diff backstop + a no-clobber eval metric.
- **Embedder CPU cost/size** → light-English default; benchmark in Phase 3; bge-m3 is opt-in.
- **Cutover risk** → new backend reaches the parity gate (Phase 2) before the default switches; old store retained; migration idempotent + re-runnable.
- **Link rot** → F12 is a *shared* service exercised from both consolidator and dashboard; round-trip tests cover every wikilink form.
- **Scope creep** → out-of-scope list in the spec is the fence; parked items stay parked.

## Cross-repo (after this lands)
Follow-on specs in the plugin repos: **session-start injection** (consumes the Phase-5 manifest endpoint) and the **`learn` transcript hook** (primary privacy gate). No in-tree harness code.

## Verification checkpoints (summary)
Each phase: `lint` + `typecheck` + `test` green, one-change PRs, CHANGELOG on user-visible changes. Gate phases: **Phase 2 parity** (existing verb tests on the new backend), **Phase 3 disposability** (rebuild equivalence), **Phase 4 eval baseline** (regression gate live), **Phase 7 cutover** (smoke/healthcheck on markdown + migration idempotent) → 1.0.0.

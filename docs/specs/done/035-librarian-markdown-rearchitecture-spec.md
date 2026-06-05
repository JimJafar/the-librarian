# Spec 035 — The Librarian: Markdown Knowledge Rearchitecture (MVP, server-side)

**Status:** Draft for review (Specify phase)
**Version target:** **1.0.0** (MAJOR — breaking storage change)
**Design input (rationale / why-not):** `~/obsidian-headless/Notes/Work/the-librarian/first-principles-reset/` — `brainstorm-mvp.md` (decisions D1–D15, features F0–F12, scenario walk S1–S18, gaps G1–G6), `candidate-shape.md` (canonical architecture + seam-check), `north-star.md`, `field-report-memsearch.md`. Treat D1–D15 + G1–G6 as **settled**; this spec restates them as testable criteria, it does not re-open them.

**Scope note (A1):** this spec is the **server side** (this repo). The client-side hooks — session-start injection and the transcript-shipping `learn` hook — ship as **separate coordinated specs** in the plugin repos (Claude/Codex/Hermes/Pi), authored *after* this one, per AGENTS.md §4 ("no in-tree harness integrations"). This spec defines the server endpoints/verbs those hooks consume.

---

## Objective

**What.** Replace The Librarian's storage core — the append-only `events.jsonl` ledger + the rebuildable SQLite projection — with a **folder of Obsidian-flavoured markdown** (source of truth) + **git** (history/audit) + a **disposable, rebuildable hybrid index**, and grow the (currently disabled) classifier into a server-side **consolidator** that files fire-and-forget submissions into evolving, topic/entity-anchored living documents.

**Why.** The append-only/unlinked model never links related memories (the "Anna problem"): a fact about Anna and a later fact about her daughter that involves Anna are stored separately and increasingly fail to co-retrieve. Markdown + a consolidator turns a log into *evolving knowledge*; git gives history/audit for free (retiring the ledger); a competitor audit (memsearch, from the Milvus vendor) independently validates markdown-as-truth + disposable-index, and confirms the *differentiation* is the consolidation + skills layers, not the substrate.

**Who.** A single owner (Jim) and the AI agents acting on his behalf across harnesses (Claude Code, Codex, Hermes, OpenCode, Pi). Single-tenant, local-first, privacy-is-the-product.

**(D16) Single-user simplifications.** No memory **scoping/partitioning** (relevance comes from *retrieval*, not walls) — drops the `domains` store + a seam bypass site; **one** server-side LLM brain — the **consolidator** (the `classifier` package is removed); the off-record `/toggle-private` **capture gate is kept** (privacy core, *distinct* from scoping); the proposal flow stays but is **risk-driven** (supersede / uncertain / `learn`), not scope/category-driven; document metadata is just `created` + `updated`.

**Success, in one line.** An agent in any harness can fire-and-forget a memory and later recall it *with its related neighbours*; the owner can read, edit, and reorganise the whole store as plain markdown (in the dashboard or Obsidian); and the store survives index loss by rebuilding from the markdown.

---

## Tech Stack

- **Runtime / build:** Node ≥ 22.5, pnpm 9.15, TypeScript (ESM), pnpm-workspace monorepo (**kept** — A2; "single npm package" is a non-goal). Packages today: `@librarian/core`, `cli`, `mcp-server`, app `dashboard` (Next.js). **(D16) `classifier` + `classifier-eval` are removed** — the **consolidator** (built on the *kept* curator pipeline) is the sole server-side LLM brain; the eval harness becomes `consolidator-eval`.
- **Kept shell (no replacement):** MCP verb contract + dispatch, auth, settings-store + `secret-crypto` (AES-256-GCM), proposal/approval flow, LLM-provider plumbing (`llm-connection`, provider adapters), the curator pipeline (behind `ApplyStore`).
- **New (storage organs) — candidate libs, final choice = Plan phase, all "ask first" per AGENTS:**
  - Frontmatter: `gray-matter`.
  - Markdown + wikilink: **`unified`/`remark`** (+ `gray-matter` frontmatter, `remark-gfm`, a wiki-link plugin) for parse / backlink-graph / dashboard render (remark→rehype). **Link rewriting = surgical string edits** at parsed link positions (not full re-stringify) to keep git diffs minimal. A round-trip test covers `[[x]]` / `[[x|alias]]` / `[[x#heading]]` / `![[embed]]`.
  - Git: **`simple-git`** (promise API over the git CLI: commit/diff/log/mv). Requires `git` installed (fine — the corpus *is* a real git repo). Fallbacks if "no git binary" ever matters: `child_process` shell-out (zero-dep) or pure-JS `isomorphic-git`.
  - Embeddings (default local): **`@huggingface/transformers` (transformers.js)** — runs the model in Node (CPU default, GPU optional, no native build). **Default = a light English model** (`bge-base-en-v1.5` / `all-MiniLM-L6-v2`, int8 on CPU); **`bge-m3` configurable** (multilingual/heavier, e.g. on Jim's GPU). Configured API provider as fallback — reuse existing provider plumbing/secret store for keys. Index is disposable → model swap = re-embed, no migration.
  - Keyword index: `MiniSearch` or `FlexSearch` (pure JS).
  - File-watcher: `chokidar` (handles add/change/unlink/rename) — drives incremental re-embed.
- **Vector search:** brute-force cosine in JS over stored embeddings (fine to ~tens of thousands of docs); ANN (hnswlib-wasm/Voy) is post-MVP, triggered by size.

---

## Commands

Existing (from `package.json`, run from repo root):

```sh
pnpm install --frozen-lockfile
pnpm run lint          # eslint + prettier
pnpm run typecheck     # tsc --noEmit, all workspaces  (run this, not just build — test files only typecheck here)
pnpm test              # build + per-pkg test:vitest + root vitest run
pnpm run smoke         # e2e against a real local server
pnpm run healthcheck   # /mcp + dashboard probes
```

New scripts this spec introduces (names TBD in Plan):

```sh
pnpm run migrate       # one-time: existing events.jsonl/SQLite memories → markdown corpus (via consolidator)
pnpm run reindex       # rebuild the disposable index from the markdown corpus
```

---

## Project Structure

Monorepo unchanged; new code lands behind existing interfaces.

```
packages/core/src/
  store/            REPLACE internals behind the same interfaces:
    librarian-store.ts   ← narrow: drop public db/eventsPath/readEvents/rebuildIndex (F0 master leak)
    memory-store.ts      ← markdown-backed impl of MemoryStore (was SQLite)
    corpus/              NEW: markdown vault I/O, frontmatter, wikilink + link-integrity (F12)
    index/               NEW: disposable hybrid index (embed + keyword + wikilink), namespaces (Tier0/Tier1)
    git/                 NEW: git-ops service (commit per write) — shared by consolidator + dashboard (F12)
    (conversation-state|handoff|curation|settings)-store.ts ← re-impl; domains-store + domain-resolution DROPPED (D16)
  consolidator/     NEW (sole LLM brain, built on the kept curator pipeline; classifier removed): navigate→judge→edit,
                         contradiction/supersede branch (G2), naming/granularity policy (G6), minimal-edit (G5)
packages/mcp-server/src/
  mcp/tools/        KEEP shapes; REMOVE domain-resolution.ts + scope args (D16); add: find_skills, get_skill,
                         search_references, add_reference, store/submit
  trpc/             REFACTOR memories.ts (MemoryShape/events), handoffs.ts (raw SQL) off storage rows
  learn endpoint    NEW: POST transcript blob → server-side extraction → proposals
apps/dashboard/     ADD vault file-manager (tree + folder view, create/edit/rename/move-menu/archive),
                         diff-based proposal review, auto-consolidation review feed (G3), manual merge (G4);
                         repoint logs-view → git history, retire/rebuild analytics
docs/specs/035-…    this spec
```

The markdown corpus itself lives **outside the repo**, at a configured vault path (default under the data dir), laid out: `inbox/`, topic folders (`people/ projects/ preferences/ lessons/`), `skills/<slug>/SKILL.md (+resources/)`, `references/`, `handoffs/`, `archive/`; the index in a sibling `.index/` (gitignored, disposable).

---

## Code Style

Match the existing repo: TypeScript ESM, `prettier` + `eslint` (enforced by `lefthook` on commit — never `--no-verify`), `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` (build conditionally; index with `arr[0]!` where proven). Conventional-commit subjects; PR body explains *why*. Errors teach (`"Expected ISO-8601 timestamp, got '2026-13-99'"`, not "Invalid input"). Example — a store method stays in domain terms, never leaks storage shapes:

```ts
// MemoryStore impl: returns a domain Memory, not a row or a file path.
async createMemory(input: NewMemory): Promise<Memory> {
  const doc = await this.corpus.writeInbox(input.text, frontmatterFor(input)); // instant, fire-and-forget
  await this.git.commit(`memory: inbox ${doc.id}`);                            // history for free
  this.index.upsert(doc, { namespace: "corpus" });                            // searchable at once (G3/S3)
  return toMemory(doc); // consolidation happens later, async, off this path
}
```

---

## Testing Strategy

- **Framework:** vitest (`pnpm test` = build + per-package `test:vitest` + root `vitest run`); Playwright e2e for the dashboard; `smoke` against a real server; `healthcheck` probes.
- **TDD per AGENTS:** regression test first for fixes; new behaviour ships with tests; test names describe behaviour.
- **New suites:**
  - `corpus` / `index` units (round-trip frontmatter + all wikilink forms; rebuild-from-markdown equals live index; namespace isolation Tier0↔Tier1).
  - `git`/link-integrity (rename/move rewrites every wikilink form; archive = move, reversible).
  - **Consolidator eval harness** (mirrors `classifier-eval`): a fixture set of submissions + expected filing decisions → measures filing accuracy, contradiction-detection recall (G2/S4 — the named soft spot), and minimal-edit/no-clobber (G5/S18). This is the quality gate for the differentiator.
  - Backlink-aware recall (G1/S2): a Sophie+Anna fact filed under either entity is retrievable from the other.
- **CI guards (A8):** retire/rewrite `check:schema-version` and `check:storage-fixture` (SQLite-projection-specific); **remove `check:classifier-env-retirement`** (classifier gone, D16); add corpus/index-integrity guards as needed.

---

## Boundaries

**Always:** run `lint` + `typecheck` + `test` before commit; branch + one-change PR + conventional commit (+ `Co-Authored-By` when an agent contributed); add a `## [Unreleased]` CHANGELOG entry for every user-visible change in the same PR; honour the privacy/off-record gate; fail-soft (a Librarian/parse/network failure never throws out of a hook, never blocks the turn, never leaks a stack trace into the model); keep `redirect: "error"` on credential-bearing outbound calls; preserve the data invariant *the markdown is the source of truth; the index is disposable and rebuildable*.

**Ask first:** adding dependencies (the new libs above are pre-approved by A7; anything else asks); changing any **cross-repo contract** — slash commands (`/handoff /takeover /learn /toggle-private`), the `active|proposed|archived` state model, the 5-heading handoff shape, the shared privacy-marker list (TS here + Hermes Python + Codex JS — all-three-or-none); CI config changes; the vault on-disk layout once data exists.

**Never:** commit secrets or put bearer tokens in URLs/logs/errors; edit `docs/specs/done/`; re-introduce per-harness code in this repo (plugins are standalone); hard-**delete** corpus content (archive = move); remove failing tests without approval; let the consolidator **clobber** hand-authored prose (minimal-edit only); bypass the privacy gate.

---

## Success Criteria (MVP features as testable conditions)

**F0 — Seal the seam.** `LibrarianStore` no longer publicly exposes `db`/`eventsPath`/`readEvents`/`rebuildIndex`; the 4 bypass sites (classifier queue, tRPC `memories`/`events`, tRPC `handoffs`, `mcp/domain-resolution.ts`) route through interfaces. *Verify:* typecheck passes with the narrowed type; grep shows no raw `store.db`/SQL outside the storage layer.

**F1 — Markdown corpus + git.** `MemoryStore` (+ conv-state/handoff/curation/settings stores; **domains dropped, D16**) are markdown-backed; every write is a git commit; **minimal frontmatter** enforced = `id, aliases, tags, category, created, updated` (no agent/source/confidence/scope — D16). *Verify:* a `remember` produces a markdown file + a commit; existing MCP verbs pass their (storage-agnostic) tests unchanged.

**F2 — Disposable hybrid index.** Semantic (brute-force cosine, bundled CPU/WASM bge-m3) + keyword + wikilink expansion; content-hash dedup; chokidar incremental re-embed on add/change/move/unlink; **separate namespaces** corpus vs references; `pnpm run reindex` rebuilds from markdown to an equivalent index. *Verify:* delete `.index/` → reindex → recall returns the same top hits; embedding-model swap → re-embed, no data loss (S13).

**F3 — Recall (backlink-aware, G1).** `recall` over Tier 1 returns a **bounded, clustered, self-contained markdown** bundle (no ID-chasing) **including inbound wikilinks/backlinks both directions**; `search_references` over Tier 0 returns pointer + relevant section. *Verify:* S2 — a Sophie+Anna fact is retrievable from *both* entities regardless of which doc it was filed under.

**F4 — Reference tier (Tier 0).** Files dropped in `references/` auto-index in a separate namespace; **not** consolidated, session-injected, or in default recall; retrieved only via `search_references`/`recall(scope:"references")`. *Verify:* S8 — adding a 23 KB doc does not change Tier-1 recall results.

**F5 — Consolidator (the sole server-side LLM brain — classifier removed, D16; built on the kept curator pipeline).** Inbox pattern (instant raw store → async file); navigate (retrieve candidates + ToC map) → judge (augment / create / supersede / archive) → minimal-edit; writes `[[wikilinks]]`; **contradiction/supersede branch drafts a diff** (G2); **doc-granularity + naming/category policy** entity/topic-level with `uncategorized/` fallback (G6); confidence band ≥0.95 auto / 0.85–0.95 proposal / ≤0.85 new (S12); proposal routing is **risk-driven** (supersede / uncertain / `learn`), never scope/category (D16); never clobbers hand-authored prose (S18/G5). *Verify:* consolidator-eval thresholds met; S1/S2/S4/S12/S18 fixtures pass.

**F6 — (client, separate spec)** session-start injection consumes a server endpoint that returns the working-style preamble + skills manifest. *Server-side criterion here:* that endpoint exists and returns a bounded manifest (name + short description) + working-style doc.

**F7 — Skills (reading + dashboard authoring).** Skills = `skills/<slug>/SKILL.md` (+ optional `resources/`); manifest derived from frontmatter; `find_skills` (semantic) + `get_skill` (full + resources). Dashboard scaffolds a new skill (folder + SKILL.md skeleton). *Verify:* S15 — author a skill in the dashboard → appears in manifest → `get_skill` returns it.

**F8 — `learn` endpoint.** Server accepts a whole-transcript blob, runs server-side extraction, emits **proposals** (or direct writes when the payload is flagged user-approved); honours the privacy gate; `/learn` slash-command contract unchanged. *Verify:* S9 — posting a transcript yields proposals in the dashboard at ~zero client tokens; the server independently drops content bearing a shared privacy marker (strip-and-send) and rejects a whole-session-off-record transcript.

**F9 — Handoffs as markdown.** store/claim/list over the new store; documents keep the **5 required headings** + carry `[[project]]` links. *Verify:* schema still refuses a handoff missing a heading; a stored handoff is a markdown file with links.

**F10 — Dashboard.** Folder-tree nav + folder view over all tiers; create/edit/rename/**move-via-menu**/archive (drag-drop = fast-follow); rendered markdown with clickable wikilinks/backlinks; **diff-based proposal review**; **auto-consolidation review feed** (G3); **manual merge** of two docs (G4); logs-view → git history; analytics retired/rebuilt. *Verify:* S10 (review/revert a consolidation), S16 (rename rewrites links), S17 (archive leaves recall, reversible).

**F11 — Seed / migration.** `pnpm run migrate` imports Jim's curated seed docs and replays existing Librarian memories through the consolidator; old store retained as backup. *Verify:* S11 — migration of the real `data/` produces a sane corpus; idempotent re-run doesn't duplicate.

**F12 — Git-ops + link-integrity service (shared).** One layer commits every file op and rewrites **all wikilink forms** on rename/move; used by **both** the consolidator (F5) and manual dashboard ops (F10). *Verify:* S16 — rename via dashboard *and* via consolidator both leave zero dangling links.

---

## In scope / Out of scope

**In:** F0–F12 (server side), the migration, the consolidator-eval harness, retiring the old-storage CI guards; **`git push` backup of the vault** + **retiring the v0.4.0 SQLite-bundle/restore-staging backup machinery and the S3 bundle target** + a **minimal settings/secret backup**.

**Out (post-MVP, parked — see brainstorm §7):** agent **skill-writing** (promotion loop) + executable-skill safety/sandbox; `get_tool`/tools tier; **decay**/tiered-degradation; **veracity** signals; cross-harness behavioural-policy **enforcement** (S14 — best-effort injection only; Hermes won't be forced to behave); multi-user / sharing-with-others; full WYSIWYG editor; drag-drop file move; wholesale Obsidian-vault ingest; ANN vector index; repackaging into a single npm module.

---

## Open Questions (for the Plan phase)

1. ✅ **RESOLVED (2026-05-31):** transformers.js + light-English default (`bge-base-en-v1.5`/`all-MiniLM-L6-v2`), `bge-m3` configurable; `remark` + `gray-matter` with surgical link rewrites; `simple-git`.
2. ✅ **RESOLVED (2026-05-31):** `inbox/` is the durable queue. Trigger = the existing index **chokidar** watcher (on `inbox/` creates) + a **boot scan** + a **5-minute safety-net tick**. **Once-only via an atomic claim** (`rename inbox/X → inbox/.processing/X`; the rename winner owns the job; a boot reaper returns stale claims). Cross-file safety via the **serial FIFO run-chain** (reused from the backup work). One item at a time (batching deferred).
3. ✅ **RESOLVED (2026-05-31):** Vault = a **dedicated git repo** at `<data-dir>/vault` (configurable via `LIBRARIAN_VAULT_PATH`; open-in-Obsidian optional — *not* the user's existing vault); `.index/` sibling, gitignored, never backed up. **Backup = `git push` to a remote** (the GitHub target → a git remote). The v0.4.0 **gzip-bundle / `VACUUM INTO` / checksummed-manifest / restart-staged-restore machinery retires** (git supersedes it); the **S3 bundle target is dropped** (git remote / S3-compatible git / tarball export covers it). **Settings + secrets get a small separate backup**, kept *out* of the vault git.
4. ✅ **RESOLVED (2026-05-31):** Two-layer gate. **Client hook = primary** (plugin specs): **strip-and-send** (drop off-record turns) + **skip `/learn` entirely for a whole-session off-record**. **Server `/learn` = defensive** (this spec): independently scans the payload against the **shared privacy-marker list** (canonical TS here, mirrored in Hermes/Codex — all-three-or-none), drops marked content, rejects whole-session-off-record; fail-soft (ambiguous → don't extract). Off-record content reaches neither the server nor the extraction LLM.
5. ✅ **RESOLVED (2026-05-31):** Migration **reuses the normal pipeline** — import seed docs first, then **enqueue each `active` memory into `inbox/`** for the consolidator to file (chronological replay so supersedes resolve). `proposed` → carried into the **proposal queue**; `archived` → `archive/` (preserved, out of recall). Metadata: `created`/`updated` → frontmatter; old `category` → filing *hint*; `scope`/`is_global`/`domain`/`recall_count`/`usefulness_score`/`curator_note` → **dropped** (D16). **Idempotent** via a migrated-IDs manifest; old store retained as backup. Accepted: a one-time bulk LLM run producing a **draft** corpus to tidy in Obsidian/dashboard.
6. ✅ **RESOLVED (2026-05-31):** Remove `check:schema-version` + `check:classifier-env-retirement`; retarget `check:storage-fixture` → a **corpus-fixture** check (frontmatter + all wikilink forms + index rebuild); **add `check:no-secrets-in-vault`** (the vault is now `git push`ed — scan for secrets, assert the secret store lives *outside* the vault). Index rebuild-equivalence, no-dangling-wikilinks, and link-rewrite round-trip live as **tests**. Keep `check:test-count`.
7. ✅ **RESOLVED (2026-05-31):** Specify the **measurement** now, set the **numbers** after a baseline. Harness (mirrors `classifier-eval`) measures filing accuracy, contradiction recall/precision, no-clobber rate, entity-resolution accuracy. Gate = **regression** (no metric drops below the frozen baseline) + **ship sign-off** on the two high-stakes metrics (contradiction-recall, no-clobber). Absolute thresholds **deferred to post-baseline**, ranked by **cost-of-failure** (no-clobber near-total; contradiction-recall high), leaning on the safety nets (G3 review feed + git reversibility + G4 manual merge) so the bar is "human-net manageable," not perfectionist. Fixture set **weighted toward hard cases** (contradictions, multi-entity, ambiguous entities, supersession, no-clobber).

---

## Follow-on specs (A1)
After this is approved + built: plugin specs for **session-start injection** (F6) and the **`learn` transcript hook** (F8) in the Claude/Codex/Hermes/Pi repos, sharing this server contract.

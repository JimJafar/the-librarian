# Spec 040: SQLite backend removal

Completes the plan-036 Phase-7 endgame ("remove dead SQLite code + old guards").
This is the **demolition spec** — a vetted, incremental sequence for deleting the
SQLite storage backend so **markdown is the only backend**. Each increment is one
PR, behind the full CI gate; `main` stays green and shippable at every step.

> Provenance: planned by a read-only architecture pass + hardened by the live
> classifier-removal work that preceded it (see "Lessons already paid for" below).
> Supersedes the gitignored build-notes roadmap.

## Objective

Remove the SQLite backend entirely. After this spec:

- `createLibrarianStore` takes **no `backend` option**; there is no
  `resolveBackend` / `LIBRARIAN_BACKEND` / `StorageBackend`. Markdown is the only
  store.
- No `node:sqlite` / `DatabaseSync` anywhere in source.
- `InternalLibrarianStore` has collapsed into `LibrarianStore` (no
  `db` / `eventsPath` / `readEvents` / `rebuildIndex`).
- The SQLite event-projection, the SQLite store implementations, the SQLite
  curator source, and the SQLite-era projection columns (`classified`) +
  `ClassifierEvaluation` event schema are gone.
- The curator still works end-to-end on the vault source + sidecar curation store.

**Who it's for:** maintainers. **Why now:** markdown is the shipped default, the
consolidator replaced the classifier (removed in #289/#291), and real data has been
migrated SQLite→markdown and promoted to `data/vault` — so SQLite is now an unused
opt-out, safe to delete.

## Current state (already done — start from here)

- ✅ Markdown is the default backend; the consolidator pipeline ships.
- ✅ Classifier subsystem fully removed (#289 source/dashboard, #291 packages +
  Dockerfiles + CI guard).
- ✅ Real SQLite data migrated → groomed → **promoted to `data/vault`** (96 memories,
  47 references).
- ✅ One-shot SQLite migration/extract tooling retired (#292); `extractActiveMemories`
  gone. The seed importer's `--extract` path stays (reads portable JSON, no SQLite).
- ➡️ **Remaining: this spec** — delete the SQLite store layer itself.

## Commands (the gate, run from repo root)

```
pnpm install --frozen-lockfile
pnpm run lint            # eslint + prettier (lefthook also runs these per-commit)
pnpm run typecheck       # tsc --noEmit across every workspace (catches the dashboard AppRouter/type coupling)
pnpm run build
pnpm test                # full vitest suite
pnpm run smoke           # end-to-end against a real local server  (must pass on MARKDOWN — see PR-2)
pnpm run healthcheck     # local /mcp + dashboard probes            (must pass on MARKDOWN — see PR-2)
```

## Project structure (the SQLite surface to remove)

```
packages/core/src/store/
  librarian-store.ts          → selector + sqlite construction branch + InternalLibrarianStore  (PR-4)
  memory-store.ts             → MIXED: sqlite createMemoryStore + shared TYPES (Memory, MemoryStore, MemoryEvent)
  curation-store.ts           → MIXED: sqlite reader defaults + CurationStore/run TYPES + CuratorMemorySource iface
  settings-store.ts           → MIXED: sqlite SettingsStore + SettingMeta TYPE (consumed by llm-connection.ts — KEEP type)
  conversation-state-store.ts → MIXED: sqlite store + ConversationStateStore TYPE
  handoff-store.ts            → MIXED: sqlite store + HandoffStore/detail TYPES + error classes
  projection.ts               → sqlite event-ledger reducer + DDL (owns the `classified` column)         (PR-3 delete)
  jsonl.ts                    → event-ledger reader (only projection + librarian-store use it)            (PR-3 delete)
packages/core/src/
  curator-source-sqlite.ts    → createSqliteCuratorMemorySource                                          (PR-3 delete)
  backup/backup.ts, backup/restore-staging.ts → VACUUM/bundle machinery                                  (PR-6 DEFERRED)
packages/mcp-server/src/bin/http.ts, bin/stdio.ts; packages/cli/src/bin.ts → drop backend:resolveBackend (PR-4)
scripts/smoke-test.js, scripts/healthcheck.js, scripts/check-storage-fixture.mjs → sqlite-pinned          (PR-2)
.github/workflows/ci.yml, package.json (check:* scripts), the four vitest.config.ts → guards/externalize  (PR-5)
```

## Plan — increments (one PR each, in this order)

Leaves before roots. The store *types* must be extracted before the store *bodies*
are deleted, and the bodies/parity tests deleted before the selector is collapsed.

### PR-1 — Extract shared types out of the mixed store files (pure refactor)
Move the type/interface exports (`Memory`, `MemoryStore`, `MemoryEvent`;
`CurationStore` + run/operation types + the `CuratorMemorySource` interface;
`SettingMeta`, `SettingsStore`; `ConversationStateStore`; `HandoffStore` + detail
types + error classes) into type-only modules (e.g. `store/memory-types.ts`,
`store/curation-types.ts`, …) and **re-export from the old paths** so no importer
changes. The SQLite `createXxxStore` functions still live in the old files and still
work. Zero behaviour change. _Verify: build + typecheck + full suite unchanged._

### PR-2 — Move smoke/healthcheck/storage-fixture CI to markdown ⚠ load-bearing
- `scripts/smoke-test.js`, `scripts/healthcheck.js`: drop the `LIBRARIAN_BACKEND=sqlite`
  pin; replace `checkSqliteRebuild` (unlink `librarian.sqlite` + rebuild) with the
  markdown **disposability** check (delete `.index/` → reindex → equivalent recall).
- Update `test/healthcheck.test.ts`: the `/SQLite rebuild/i` probe assertion →
  the markdown reindex check's label. (This test was just de-flaked in #290 — keep
  the beforeAll-once structure.)
- Retire `check:storage-fixture` (SQLite-projection rebuild) — drop the script + its
  CI step, or repoint to a corpus-fixture check.
- Must land **before** any `node:sqlite` deletion so CI's smoke/healthcheck never hits
  a missing module. _Verify: `pnpm smoke && pnpm healthcheck` green on markdown; CI
  smoke/healthcheck + dashboard e2e green._

### PR-3 — Delete the SQLite store implementations + projection + parity surgery
- Delete the SQLite `createXxxStore` bodies (keep the PR-1 type modules), `projection.ts`,
  `curator-source-sqlite.ts`, `jsonl.ts`. Split `curation-store.ts`: keep the types +
  `CuratorMemorySource` interface, delete the `createSqlite*` defaults (markdown always
  injects `createVaultCuratorMemorySource`).
- Drop the SQLite-era `classified` projection column + the `ClassifierEvaluation` event
  schema (`schemas/common.ts`, `schemas/events.ts`) and the stale `replay-verify-outcomes`
  comments left behind in #292.
- Delete SQLite store tests (`memory-store`, `handoff-store`, `settings-store`,
  `conversation-state-store`, `curation-store`, `curation-reads`, `projection`,
  `actor-kind`, `d1-1-bulk-update`, sqlite-only `verify-scoring`/`caller-backfill`).
- **Parity-suite surgery:** the markdown/SQLite parity tests
  (`store/markdown/markdown-memory-parity.test.ts` + siblings, `sidecar-curation-store`,
  `memory-routing`, `memory-agent-id-queries`) assert markdown == the SQLite baseline.
  **Keep the markdown assertions, delete the SQLite arm**, and re-anchor any
  "equals the sqlite result" expectation to a literal value. Rewrite the curator tests
  (`curator-evidence/slices/apply/scheduler`) to use `createVaultCuratorMemorySource`
  instead of `createSqliteCuratorMemorySource(store.db)`.
- _Verify: build + typecheck + suite green; this is the highest-care PR — read each
  parity test before cutting._

### PR-4 — Collapse the selector to markdown-only
Delete the `backend === "sqlite"` branch in `librarian-store.ts`; make
`createLibrarianStore` markdown-only; drop `StorageBackend` / `resolveBackend` / the
`backend` option / `InternalLibrarianStore.db`/`eventsPath`/`readEvents`/`rebuildIndex`;
remove the `DatabaseSync` import + the residual-`db` plumbing in the markdown branch.
Update bins (`bin/http.ts`, `bin/stdio.ts`, `cli/src/bin.ts`) to drop
`backend: resolveBackend()`. Rewrite/delete `resolve-backend.test.ts` +
`librarian-store-backend.test.ts` (markdown-only). Must come **after** PR-3 (it's the root).

### PR-5 — Final sweep
Retire `check:no-store-bypass` + `check:storage-fixture` guards (script + npm script +
CI step) if not already; remove the `node:sqlite` externalize comments in the four
`vitest.config.ts`; `CHANGELOG.md` entry; confirm the verification checklist; lower
`test/baseline.json` **only if** the count fell below the floor (see Boundaries).

### PR-6 — Backup machinery 🛑 DEFERRED (do WITH the maintainer)
`backup/backup.ts` (`VACUUM INTO`, `getSchemaVersion(store.db)`), `backup/restore-staging.ts`,
`backup/run.ts`, `trpc/backup.ts`, and the dashboard `/backups` page. This is a
**build-and-replace** (the plan-036 `git push` backup), not a deletion — deleting it
breaks the scheduled backup + the dashboard build. Not safe unattended.

## Lessons already paid for (don't relearn these)

- **Grep beyond `*.ts`.** A removed package's refs also hide in `docker/*.Dockerfile`
  (COPY + `--filter`), `scripts/`, `.github/workflows/ci.yml`, `package.json` deps, and
  `vitest.config.ts` externalize lists. The classifier removal's container build failed
  on missed Dockerfile COPYs. For SQLite, grep `node:sqlite`, `DatabaseSync`,
  `LIBRARIAN_BACKEND`, `sqlite`, `librarian.sqlite`, `VACUUM` across **all** of those.
- **Don't retighten `test/baseline.json`.** It's a *loose* floor (177) for
  `check:test-count`, not the exact count (actual ≈ 1300+). Deleting SQLite tests stays
  far above 177 — leave the floor unless it actually drops below. (A prior pass wrongly
  bumped it 177→1333; that fails on any future deletion.)

## Code style

Match the surrounding code. Type-only modules use `export type { … }`. Re-export
shims keep the old import paths working (`export type { Memory } from "./memory-types.js";`).
Conventional commits (`refactor(core):`, `chore:`); body explains the *why*;
`Co-Authored-By:` trailer when an agent contributed.

## Testing strategy

Vitest across the workspace + the root `test/**`. Every deleting PR keeps `pnpm test`
green. PR-2 + PR-4 additionally need `pnpm smoke` + `pnpm healthcheck` green on
markdown (and CI's dashboard e2e). No new test infra — delete the SQLite tests,
re-anchor the parity tests to markdown-only literals.

## Boundaries

- **Always:** one increment per PR; full gate green before merge; merge only on green
  CI (4 checks incl. container build + dashboard e2e); branch + PR, never push to main;
  never `--no-verify`; CHANGELOG on user-visible changes.
- **Ask first:** PR-6 (backup machinery — build-and-replace, needs the maintainer);
  any change to the curator's runtime path; lowering the baseline floor.
- **Never:** touch `llm-connection.ts`, `curator-config.ts`, `curator-source-vault.ts`,
  the `sidecar/*` stores, or the consolidator (all KEPT, curator depends on them);
  edit `docs/specs/done/` (archival).

## Success criteria (verification checklist)

- [ ] `grep -rn "node:sqlite\|DatabaseSync" packages apps --include='*.ts' | grep -v /dist/` → empty
- [ ] `grep -rn "LIBRARIAN_BACKEND\|resolveBackend\|StorageBackend\|backend: \"sqlite\"" packages apps scripts` → empty
- [ ] `grep -rn "sqlite\|librarian.sqlite\|VACUUM" packages apps scripts docker .github` → clean except `docs/`, `CHANGELOG.md`, `docs/specs/done/`
- [ ] `pnpm install --frozen-lockfile && pnpm build && pnpm typecheck && pnpm lint` green
- [ ] `pnpm test` green; `test/baseline.json` floor still satisfied (not retightened)
- [ ] `pnpm run smoke && pnpm run healthcheck` green on markdown
- [ ] dashboard build + Playwright e2e green
- [ ] curator still grooms (consolidator-eval suite green)
- [ ] PR-6 (backup) consciously deferred with a tombstone, OR done with the maintainer

## Open questions

- PR-2's markdown disposability check: reuse an existing `reindex` entrypoint, or add a
  thin one for the smoke/healthcheck scripts? (Resolve when implementing PR-2.)
- PR-6 backup replacement (git-push) — separate spec, with the maintainer.

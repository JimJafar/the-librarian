# Tasks: Maintainability overhaul

Per-PR breakdown of [`specs/002-maintainability-overhaul.md`](./002-maintainability-overhaul.md) and [`specs/003-maintainability-overhaul-plan.md`](./003-maintainability-overhaul-plan.md). Each task is one PR. Check them off as PRs land.

## Status

Implemented 2026-05-21 — all 30 tasks landed on `main`. The per-task acceptance criteria below are kept as a historical record; do not edit them retroactively. New maintainability work should propose a new spec rather than amending this one.

## Conventions

- Each task is one PR.
- **Acceptance** = what must be true when the PR lands.
- **Verify** = exact command(s) that prove acceptance.
- **Files** = rough scope (not every line; the major ones).
- **Blocks/Blocked by** = task IDs from this list.
- Every PR also clears the standard quartet: `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm healthcheck`. Only call out exceptions where a phase has a temporarily-broken check (e.g. P1.1 doesn't have `pnpm lint` configured yet).
- Every PR references the spec phase it implements ("implements Phase 3 of specs/002-maintainability-overhaul.md").

---

## Phase 1 — Foundation

### T1.1 — pnpm workspaces scaffold + lockfile migration

- **Acceptance:** Root has `pnpm-workspace.yaml` defining `packages/*` and `apps/*`. Root `package.json` becomes a workspace root (no source code, just dev scripts). `package-lock.json` is removed; `pnpm-lock.yaml` exists. Empty `packages/core/`, `packages/mcp-server/`, `packages/cli/`, `apps/dashboard/` directories exist with placeholder `package.json` files. `tsconfig.base.json` exists with strict settings; each package has a `tsconfig.json` extending it. The existing `src/*.js` and `test/*.test.js` still run via the root scripts.
- **Verify:**
  ```sh
  pnpm install --frozen-lockfile
  pnpm test                      # legacy script delegating to node --test still works
  pnpm run smoke                 # passes
  pnpm run healthcheck           # passes
  ```
- **Files:** `pnpm-workspace.yaml`, `tsconfig.base.json`, `package.json` (root), `pnpm-lock.yaml`, `packages/{core,mcp-server,cli}/package.json`, `packages/{core,mcp-server,cli}/tsconfig.json`, `apps/dashboard/package.json`, `apps/dashboard/tsconfig.json`, `package-lock.json` (deleted), `README.md` (note the lockfile migration).
- **Blocks:** T1.2, T1.3, T1.4, T2.1
- **Blocked by:** —

### T1.2 — ESLint flat config + Prettier + Lefthook

- **Acceptance:** `eslint.config.mjs` (flat config) with `@typescript-eslint`, `import`, `unicorn`, `vitest` plugins. Hard-enforced rules: `@typescript-eslint/no-explicit-any: error` and `@typescript-eslint/ban-ts-comment` rejecting `@ts-ignore` (allowing `@ts-expect-error` only with a description). `.prettierrc` defining the house style. `lefthook.yml` with a `pre-commit` hook running `prettier --check` and `eslint --max-warnings 0` on staged files. `pnpm lint` and `pnpm format` work at the root. The existing `.js` source passes lint with zero errors. An intentional Prettier violation in a feature branch is rejected by the pre-commit hook (manual verification step in the PR description).
- **Verify:**
  ```sh
  pnpm install
  pnpm lint                      # zero errors on existing tree
  pnpm format --check            # zero changes needed
  # Manual: stage a file with Prettier-violating whitespace; attempt commit; hook blocks.
  ```
- **Files:** `eslint.config.mjs`, `.prettierrc`, `.prettierignore`, `lefthook.yml`, `.editorconfig`, `package.json` (devDependencies).
- **Blocks:** T1.4
- **Blocked by:** T1.1

### T1.3 — Vitest installed at root (both runners coexist briefly)

- **Acceptance:** Vitest is installed at the workspace root with a `vitest.config.ts` scaffold (empty `include` pattern; will fill in as tests convert). `pnpm test` continues to run the existing `node:test` suite during the migration window — no test file is converted in this PR. `pnpm test:vitest` (new) runs the (currently empty) Vitest suite as a smoke test that the runner boots. Per-package empty `vitest.config.ts` scaffolds. **Test conversions are staged per-package**: each phase that ports a module ALSO converts that module's tests to Vitest in the same PR (see T3.1+, T4.1+, T5.1).
- **Verify:**
  ```sh
  pnpm test                      # legacy node:test suite still passes (unchanged)
  pnpm test:vitest               # Vitest runs (0 tests) without error
  ```
- **Files:** `vitest.config.ts` (workspace root), root `package.json` (`scripts.test:vitest`, devDependencies), per-package empty `vitest.config.ts` scaffolds.
- **Blocks:** T1.4, T3.1+
- **Blocked by:** T1.1
- **Note:** When the last `node:test` file is converted (likely during P5 or P6 testing), a follow-up swaps `pnpm test` to point at Vitest and removes the `pnpm test:vitest` alias.

### T1.4 — GitHub Actions CI workflow + enforcement guards + PR template

- **Acceptance:** `.github/workflows/ci.yml` runs on push/PR. Steps: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (legacy + Vitest), `pnpm build`, `pnpm healthcheck`. **Three enforcement guards land in the same workflow**:
  1. **Test-count floor:** `test/baseline.json` checked into the repo with `{ "count": N }`. CI fails if `pnpm test --reporter=json` reports fewer tests than `baseline.count`. PR description must explain any deliberate reduction and update the baseline.
  2. **Integration wrapper smoke:** CI matrix step that runs each `integrations/<harness>/wrapper.sh` against a local MCP server with `echo ok` as the wrapped command. Catches CLI surface regressions.
  3. **Storage compatibility fixture:** `test/fixtures/pre-migration/events.jsonl` and `sessions.jsonl` (frozen snapshots from before the migration). CI loads them, runs `rebuildIndex`, asserts the projection produces the expected memory and session counts.

  **PR template** at `.github/pull_request_template.md` with required sections: spec/phase reference, summary, test plan, plus two checkboxes that authors must tick: "no production source file over 400 LOC introduced (or noted if so) — applies to `packages/*/src/` and `apps/*/src/`, not tests" and "no new `any` / `@ts-ignore` introduced (or noted if so)".

  CI passes on a noop PR. Status badge added to `README.md`.
- **Verify:** Open a noop PR; CI green on all three guards plus the standard quartet; the new PR template auto-populates the body. `README.md` shows the badge.
- **Files:** `.github/workflows/ci.yml`, `.github/pull_request_template.md`, `test/baseline.json`, `test/fixtures/pre-migration/{events,sessions}.jsonl`, `scripts/check-test-count.mjs` (helper), `scripts/check-storage-fixture.mjs`, `README.md` (badge).
- **Blocks:** —
- **Blocked by:** T1.1, T1.2, T1.3

---

## Phase 2 — Relocate source into packages

### T2.1 — Atomic relocation of src/ → packages/*/src/

- **Acceptance:** `src/store.js`, `src/constants.js` → `packages/core/src/`. `src/server.js` → `packages/mcp-server/src/bin/stdio.js`. `src/dashboard.js` → `packages/mcp-server/src/bin/http.js`. `src/mcp.js` → `packages/mcp-server/src/mcp/dispatch.js`. `src/cli.js` → `packages/cli/src/cli.js` (plus a new `packages/cli/src/bin.js` stub for the executable entry). `public/` → `packages/mcp-server/public/`. `test/*.test.js` files follow their source into the matching package's `tests/` directory. `scripts/healthcheck.js` and `scripts/smoke-test.js` stay at the root (cross-package). `package.json` `bin` field moves to `packages/cli/package.json`. Root scripts delegate via `pnpm --filter`. Internal imports updated to the new paths. **No behavior change.**
- **Verify:**
  ```sh
  pnpm install
  pnpm test                      # all tests pass at the new paths
  pnpm --filter @librarian/mcp-server start    # boots stdio MCP server
  pnpm --filter @librarian/mcp-server serve    # boots HTTP service
  pnpm --filter @librarian/cli build           # CLI binary builds
  the-librarian sessions list   # CLI works end-to-end (after pnpm install symlinks the bin)
  pnpm run smoke                 # legacy smoke test still passes
  pnpm run healthcheck           # passes
  ```
- **Files:** Every file in `src/` and `test/` (moved). `package.json` (root + per-package). `README.md` (paths updated).
- **Blocks:** T3.1
- **Blocked by:** T1.1

---

## Phase 3 — Port @librarian/core to TypeScript

### T3.1 — Zod schemas + types

- **Acceptance:** `packages/core/src/schemas/` contains Zod schemas for `Memory`, `MemoryEvent` (the JSONL ledger events), `Session`, `SessionEvent`, and the payload type unions (memory categories, session payload types, capture modes, etc.). Types are inferred from schemas — no hand-written duplicates. Schemas are exported from `packages/core/src/index.ts`. **No code is using them yet** — this is the foundation.
- **Verify:**
  ```sh
  pnpm --filter @librarian/core build           # clean .d.ts emitted
  pnpm --filter @librarian/core typecheck       # zero errors
  ```
- **Files:** `packages/core/src/schemas/{memory,session,events,index}.ts`, `packages/core/src/index.ts`, `packages/core/package.json` (Zod dep).
- **Blocks:** T3.2, T3.3, T3.4, T3.5
- **Blocked by:** T2.1, T1.3

### T3.2 — JSONL helpers + projection module

- **Acceptance:** `packages/core/src/store/jsonl.ts` exports typed `readJsonl`, `appendJsonl` helpers. `packages/core/src/store/projection.ts` owns the SQLite schema + incremental insert path for both memory and session projections. The existing `_rebuildMemoryIndex` and `_rebuildSessionIndex` move here; the original `LibrarianStore` methods now delegate. **Tests in this PR convert to Vitest** (`node:test` → `vitest`'s `describe`/`it`, `assert/strict` → `expect`) as part of the move; this is the first wave of the staged Vitest migration. Tests covering rebuild parity end up at `packages/core/tests/store/projection.test.ts` and pass.
- **Verify:**
  ```sh
  pnpm --filter @librarian/core test            # rebuild tests pass
  pnpm --filter @librarian/core typecheck
  ```
- **Files:** `packages/core/src/store/{jsonl,projection}.ts`, `packages/core/tests/store/{jsonl,projection}.test.ts`. `packages/core/src/store/index.ts` (re-exports). Original `store.js` shrinks correspondingly.
- **Blocks:** T3.3, T3.4
- **Blocked by:** T3.1

### T3.3 — Memory store module

- **Acceptance:** `packages/core/src/store/memory-store.ts` exports a `createMemoryStore(deps)` factory containing all memory CRUD (`createMemory`, `updateMemory`, `deleteMemory`, `verifyMemory`, `approveProposal`, `resolveConflict`, `searchMemories`, `listMemories`, `getMemory`, `getRelated`, `getAggregates`, `recordRecall`, `startContext`). The existing `LibrarianStore` class delegates to it. All memory-related tests pass at their new TS location. **Tests in this PR convert to Vitest** (per the staged migration started in T3.2).
- **Verify:**
  ```sh
  pnpm --filter @librarian/core test            # memory tests pass
  pnpm --filter @librarian/core typecheck
  ```
- **Files:** `packages/core/src/store/memory-store.ts`, `packages/core/tests/store/memory-store.test.ts` (split from the monolithic `store.test.ts` as needed).
- **Blocks:** T3.5
- **Blocked by:** T3.2

### T3.4 — Session store module

- **Acceptance:** `packages/core/src/store/session-store.ts` exports `createSessionStore(deps)` containing all session lifecycle (`startSession`, `getSession`, `listSessions`, `searchSessions`, `recordSessionEvent`, `listSessionEvents`, `checkpointSession`, `pauseSession`, `endSession`, `attachSession`, `continueSession`, `archiveSession`, `restoreSession`, `deleteSession`, `promoteSessionFact`). The existing `LibrarianStore` class delegates. All session-related tests pass. **Tests convert to Vitest** in this PR.
- **Verify:**
  ```sh
  pnpm --filter @librarian/core test            # session tests pass
  pnpm --filter @librarian/core typecheck
  pnpm run healthcheck                           # session lifecycle check still passes
  ```
- **Files:** `packages/core/src/store/session-store.ts`, `packages/core/tests/store/session-store.test.ts`, `packages/core/tests/store/sessions-rebuild.test.ts` etc.
- **Blocks:** T3.5
- **Blocked by:** T3.2

### T3.5 — Formatters + final core facade

- **Acceptance:** `packages/core/src/formatters/` owns the prose / markdown / per-harness handover renderers (formerly `renderHandover*` in `store.js`). `LibrarianStore` becomes a thin facade re-exported from `packages/core/src/index.ts`; the file is < 100 LOC. All of `store.js` is gone; the `.ts` modules under `src/store/` and `src/formatters/` cover its surface. Memory + session + projection + formatter tests all pass.
- **Verify:**
  ```sh
  pnpm --filter @librarian/core test
  pnpm --filter @librarian/core typecheck
  pnpm --filter @librarian/core build           # clean .d.ts
  # Public type surface unchanged: downstream packages still compile against the published types
  pnpm --filter @librarian/mcp-server typecheck
  pnpm --filter @librarian/cli typecheck
  ```
- **Files:** `packages/core/src/formatters/{prose,markdown,index}.ts`, `packages/core/src/index.ts` (final shape), removal of `packages/core/src/store.js`.
- **Blocks:** T4.1, T5.1
- **Blocked by:** T3.3, T3.4

### T3.6 — Schema-version sentinel for projection rebuilds

- **Acceptance:** `initSchema` in `packages/core/src/store/projection.ts` stamps a `PRAGMA user_version = N` matching a `PROJECTION_SCHEMA_VERSION` constant bumped whenever the SQLite shape changes. On store open, if the on-disk `user_version` is lower (or zero on an existing DB), the projection is auto-rebuilt from the JSONL ledgers before any reads are served. Rationale: the projection model means we don't need ALTER-style migrations — but we do need to detect a stale on-disk DB and rebuild it transparently, otherwise schema changes silently break existing installs. (Came out of PR #11 review — alternative to introducing an ORM.)
- **Verify:**
  ```sh
  pnpm --filter @librarian/core test
  # New test: bump PROJECTION_SCHEMA_VERSION, open store against a pre-existing DB,
  # confirm rebuildIndex() ran and PRAGMA user_version is now current.
  ```
- **Files:** `packages/core/src/store/projection.ts`, `packages/core/src/store.js` (or the T3.5 facade), `packages/core/tests/store/projection.test.ts`.
- **Blocks:** —
- **Blocked by:** T3.2

---

## Phase 4 — mcp-server TS port + tRPC

### T4.1 — TS port of HTTP server + auth middleware

- **Acceptance:** `packages/mcp-server/src/http/server.ts` and `packages/mcp-server/src/http/auth.ts` are TS. The HTTP entrypoint at `packages/mcp-server/src/bin/http.ts` boots the server. Auth (`authenticateMcp`, origin checks, token validation) is extracted into a reusable middleware. All HTTP tests pass at their new TS location. **HTTP tests convert to Vitest** in this PR. **No behavior change.**
- **Verify:**
  ```sh
  pnpm --filter @librarian/mcp-server test
  pnpm --filter @librarian/mcp-server typecheck
  pnpm run healthcheck                           # HTTP MCP + auth check passes
  ```
- **Files:** `packages/mcp-server/src/http/{server,auth,routes}.ts`, `packages/mcp-server/src/bin/http.ts`, `packages/mcp-server/tests/http/*.test.ts` (port from existing).
- **Blocks:** T4.2, T4.3
- **Blocked by:** T3.5

### T4.2 — MCP dispatch + per-tool files

- **Acceptance:** `packages/mcp-server/src/mcp/dispatch.ts` is TS. The existing `callTool` switch is replaced by a registry that maps tool names to per-tool handler files under `packages/mcp-server/src/mcp/tools/` (one file per MCP tool — `start-session.ts`, `list-sessions.ts`, …, plus the memory tools). Each handler imports its Zod input schema from `@librarian/core/schemas`. `dispatch.ts` is < 100 LOC. The stdio entry at `packages/mcp-server/src/bin/stdio.ts` is TS. All MCP tests pass. **MCP tests convert to Vitest** in this PR.
- **Verify:**
  ```sh
  pnpm --filter @librarian/mcp-server test
  pnpm --filter @librarian/mcp-server typecheck
  pnpm run healthcheck                           # MCP stdio + HTTP checks pass
  ```
- **Files:** `packages/mcp-server/src/mcp/dispatch.ts`, `packages/mcp-server/src/mcp/tools/*.ts` (one per tool), `packages/mcp-server/src/mcp/visibility.ts`, `packages/mcp-server/src/bin/stdio.ts`, tests.
- **Blocks:** T4.4, T4.5
- **Blocked by:** T4.1

### T4.3 — tRPC scaffold

- **Acceptance:** `packages/mcp-server/src/trpc/router.ts` exports an `appRouter` with empty routers for `memories` and `sessions`. tRPC mounted at `/trpc/*` on the HTTP server. Context resolves admin role from `LIBRARIAN_ADMIN_TOKEN` bearer. Health probe procedure (`appRouter.health.ping`) returns `{ ok: true }` for typed-client smoke testing. **`AppRouter` type exported from `packages/mcp-server/src/index.ts`** for the dashboard to import.
- **Verify:**
  ```sh
  pnpm --filter @librarian/mcp-server test       # tRPC mount test passes
  pnpm --filter @librarian/mcp-server typecheck
  curl -s -H "Authorization: Bearer $LIBRARIAN_ADMIN_TOKEN" \
    http://127.0.0.1:3838/trpc/health.ping       # returns {result: {data: {ok: true}}}
  ```
- **Files:** `packages/mcp-server/src/trpc/{router,context,health}.ts`, `packages/mcp-server/src/http/routes.ts` (mount tRPC), `packages/mcp-server/src/index.ts` (`AppRouter` export), `packages/mcp-server/tests/trpc/health.test.ts`.
- **Blocks:** T4.4, T4.5, T6.2
- **Blocked by:** T4.1

### T4.4 — tRPC memory procedures

- **Acceptance:** `packages/mcp-server/src/trpc/memories.ts` exposes typed procedures mirroring the current `/api/memories*`, `/api/proposals*`, `/api/events`, `/api/aggregates`, `/api/recall`, `/api/memories/:id/related` endpoints (read + write). Input/output schemas come from `@librarian/core/schemas`. The old REST routes stay live (deprecated, deletion in P7). Integration tests cover the new procedures.
- **Verify:**
  ```sh
  pnpm --filter @librarian/mcp-server test
  pnpm --filter @librarian/mcp-server typecheck
  ```
- **Files:** `packages/mcp-server/src/trpc/memories.ts`, `packages/mcp-server/tests/trpc/memories.test.ts`, `packages/mcp-server/src/trpc/router.ts` (mount memories router).
- **Blocks:** T6.3, T6.4
- **Blocked by:** T4.3

### T4.5 — tRPC session procedures

- **Acceptance:** `packages/mcp-server/src/trpc/sessions.ts` exposes typed procedures mirroring `/api/sessions*` (list, get, events, search, checkpoint, pause, end, archive, restore, delete, continue, promote). Integration tests cover each.
- **Verify:**
  ```sh
  pnpm --filter @librarian/mcp-server test
  pnpm --filter @librarian/mcp-server typecheck
  pnpm run healthcheck
  ```
- **Files:** `packages/mcp-server/src/trpc/sessions.ts`, `packages/mcp-server/tests/trpc/sessions.test.ts`, `packages/mcp-server/src/trpc/router.ts` (mount).
- **Blocks:** T6.5, T6.6
- **Blocked by:** T4.3, T4.2

### T4.6 — pino logging migration

- **Acceptance:** All `console.log` / `console.error` in `packages/mcp-server` are replaced with a shared pino logger. pino-pretty is the dev formatter; raw NDJSON in production. Log level controlled by `LIBRARIAN_LOG_LEVEL` env. Healthcheck output cosmetics may shift; the script must still pass.
- **Verify:**
  ```sh
  pnpm --filter @librarian/mcp-server start &     # logs are NDJSON
  pnpm run healthcheck                            # passes (parser tolerates either)
  ```
- **Files:** `packages/mcp-server/src/logging.ts`, every TS file in `packages/mcp-server/src/` that previously called `console.*`.
- **Blocks:** —
- **Blocked by:** T4.1

---

## Phase 5 — CLI TS port

### T5.1 — TS port of CLI runtime + flag parser

- **Acceptance:** `packages/cli/src/runtime.ts` exposes a typed `runCli(argv, store)` returning `{ stdout, exitCode }`. `packages/cli/src/bin.ts` is the `#!/usr/bin/env node` entry, builds via tsc, and is referenced by `packages/cli/package.json` `bin`. All CLI tests pass at the new TS location. **CLI tests convert to Vitest** in this PR — likely the last wave of the staged migration; T5.1 or T5.2 also flips `pnpm test` to point at Vitest exclusively and removes the `pnpm test:vitest` alias from T1.3.
- **Verify:**
  ```sh
  pnpm --filter @librarian/cli test
  pnpm --filter @librarian/cli build
  the-librarian sessions list                    # post-build, the binary works
  pnpm --filter @librarian/cli typecheck
  ```
- **Files:** `packages/cli/src/{runtime,bin,parse-flags}.ts`, `packages/cli/package.json` (bin + build script), tests.
- **Blocks:** T5.2
- **Blocked by:** T3.5

### T5.2 — Per-verb file split

- **Acceptance:** Each verb (start, list, show, checkpoint, pause, end, attach, continue, archive, restore, delete, search, events) lives in its own file under `packages/cli/src/commands/`. `runtime.ts` dispatches to them. Each file is < 100 LOC. Snapshot tests against `--help` output and `--json` output ensure no regression.
- **Verify:**
  ```sh
  pnpm --filter @librarian/cli test
  pnpm --filter @librarian/cli typecheck
  # Healthcheck against every integration wrapper script
  bash integrations/claude-code/wrapper.sh --project the-librarian --title test -- echo ok
  bash integrations/codex/wrapper.sh --project the-librarian --title test -- echo ok
  bash integrations/opencode/wrapper.sh --project the-librarian --title test -- echo ok
  bash integrations/pi/wrapper.sh --project the-librarian --device t --title test -- echo ok
  ```
- **Files:** `packages/cli/src/commands/*.ts` (13 files), `packages/cli/src/runtime.ts` (dispatch trimmed).
- **Blocks:** —
- **Blocked by:** T5.1

---

## Phase 6 — Next.js dashboard

### T6.1 — Next.js + Tailwind + shadcn scaffold

- **Acceptance:** `apps/dashboard/` is a working Next.js 15 App Router app with Tailwind v4 and shadcn/ui initialised (button, input, dialog, card, table, badge, tabs primitives copied in). Root layout, theme, dark mode toggle. `apps/dashboard/app/page.tsx` is a placeholder "Hello Librarian" page. `pnpm --filter @librarian/dashboard dev` boots on a separate port (configurable; default 3000) with hot reload.
- **Verify:**
  ```sh
  pnpm --filter @librarian/dashboard build       # clean Next.js standalone build
  pnpm --filter @librarian/dashboard dev &
  curl -s http://127.0.0.1:3000/ | grep "Hello Librarian"
  ```
- **Files:** `apps/dashboard/app/{layout,page,globals.css}.tsx`, `apps/dashboard/components/ui/*.tsx`, `apps/dashboard/tailwind.config.ts`, `apps/dashboard/next.config.mjs`, `apps/dashboard/package.json`.
- **Blocks:** T6.2
- **Blocked by:** T1.1

### T6.2 — tRPC client + admin auth wiring

- **Acceptance:** Dashboard imports `AppRouter` type from `@librarian/mcp-server`. Two tRPC client surfaces: (a) server-side caller in `apps/dashboard/lib/trpc-server.ts` for use in Server Components and Server Actions; (b) browser-side client in `apps/dashboard/lib/trpc-client.ts` via `@tanstack/react-query`. Both authenticate with `LIBRARIAN_ADMIN_TOKEN` env. A demo Server Component on `/health` page calls `appRouter.health.ping` and renders the result.
- **Verify:**
  ```sh
  LIBRARIAN_ADMIN_TOKEN=… pnpm --filter @librarian/dashboard dev &
  curl -s http://127.0.0.1:3000/health | grep '"ok":true'
  ```
- **Files:** `apps/dashboard/lib/{trpc-server,trpc-client}.ts`, `apps/dashboard/app/health/page.tsx`, `apps/dashboard/package.json` (deps on `@trpc/client`, `@trpc/react-query`, `@tanstack/react-query`, type-only on `@librarian/mcp-server`).
- **Blocks:** T6.3, T6.5
- **Blocked by:** T6.1, T4.3

### T6.3 — Memories page (browse + filters + sort + detail)

- **Acceptance:** `apps/dashboard/app/(memories)/page.tsx` renders the memories list with sidebar filters (search, agent, project, category, visibility, date range), sort controls, pagination, and a detail panel matching the current dashboard. Edit memory action via Server Action. New-memory form. Recall action. Feature parity with the Browse tab of the current dashboard.
- **Verify:**
  ```sh
  pnpm --filter @librarian/dashboard build
  # Manual: side-by-side comparison against the legacy dashboard.
  # The PR description includes a feature-parity checklist with checkboxes.
  ```
- **Files:** `apps/dashboard/app/(memories)/{page,layout}.tsx`, `apps/dashboard/components/memories/*.tsx` (list, card, detail-panel, filters, sort, new-form, edit-form).
- **Blocks:** T6.4
- **Blocked by:** T6.2, T4.4

### T6.4 — Memories: analytics, proposals, conflicts, archive, logs tabs

- **Acceptance:** All remaining tabs of the current dashboard land as routes under `app/`: `/analytics` (charts), `/proposals`, `/conflicts`, `/archive`, `/logs`. Each matches the current behavior. Analytics uses Recharts (or similar); the dependency is justified in the PR.
- **Verify:** Manual side-by-side comparison; feature-parity checklist.
- **Files:** `apps/dashboard/app/{analytics,proposals,conflicts,archive,logs}/page.tsx`, supporting components.
- **Blocks:** T6.7
- **Blocked by:** T6.3

### T6.5 — Sessions list page

- **Acceptance:** `apps/dashboard/app/sessions/page.tsx` renders the sessions list with the spec's columns (status with stale indicator, title, project, visibility, harness, agent, source, last activity, next step), search filter, project filter, include-archived/deleted toggles. Click-through to detail page. Matches the current Sessions tab.
- **Verify:** Manual comparison + feature-parity checklist.
- **Files:** `apps/dashboard/app/sessions/page.tsx`, `apps/dashboard/components/sessions/{list,row,filters,search}.tsx`.
- **Blocks:** T6.6
- **Blocked by:** T6.2, T4.5

### T6.6 — Session detail page + lifecycle controls + handover + promote

- **Acceptance:** `apps/dashboard/app/sessions/[id]/page.tsx` renders the full session detail: header (title, status, ids), summaries (start/rolling/end), event stream, lifecycle controls (checkpoint, pause, end, archive, restore, delete with confirm), continue/handover form, promote-to-memory form. All write actions via Server Actions calling tRPC. Matches the current detail panel exactly.
- **Verify:** Manual side-by-side; feature-parity checklist.
- **Files:** `apps/dashboard/app/sessions/[id]/page.tsx`, `apps/dashboard/components/sessions/{detail,events-stream,lifecycle-actions,handover-form,promote-form}.tsx`, `apps/dashboard/app/sessions/[id]/actions.ts` (Server Actions).
- **Blocks:** T6.7
- **Blocked by:** T6.5

### T6.7 — Playwright e2e pass

- **Acceptance:** Playwright is installed in `apps/dashboard`. Three e2e tests at minimum:
  1. Memories list renders with at least one memory; clicking a memory opens detail.
  2. Sessions list renders; archive/restore round-trip on a test session.
  3. Promote-to-memory form submits and the new memory appears in the Memories tab.
  CI runs Playwright headless against a built `apps/dashboard` + a fresh `mcp-server` with a temp data dir.
- **Verify:**
  ```sh
  pnpm --filter @librarian/dashboard test:e2e
  # CI: green
  ```
- **Files:** `apps/dashboard/e2e/{memories,sessions,promote}.spec.ts`, `apps/dashboard/playwright.config.ts`, `.github/workflows/ci.yml` (e2e job).
- **Blocks:** T7.1
- **Blocked by:** T6.4, T6.6

---

## Phase 7 — Retire the old dashboard

### T7.1 — Remove public/, retire /api/* REST, cut over

- **Acceptance:** `packages/mcp-server/public/` deleted. All `/api/*` REST routes deleted from `packages/mcp-server/src/http/routes.ts` (only `/mcp`, `/trpc/*`, `/healthz` remain). The legacy `serveDashboardFile` paths (`/`, `/styles.css`, `/app.js`) are deleted. `grep -rn "/api/" packages/ apps/` returns zero hits. `README.md`, `DEPLOYMENT.md`, and integration package docs updated to point at the new dashboard (default port 3000) and the MCP server (3838). Integration wrapper scripts unchanged (CLI surface preserved).
- **Verify:**
  ```sh
  # Restrict to source files; .md docs may legitimately mention historical /api/ paths
  grep -rn "/api/" packages/ apps/ --include="*.ts" --include="*.tsx" --include="*.js"  # zero hits
  pnpm test
  pnpm run healthcheck
  # Manual: legacy dashboard URL returns 404
  ```
- **Files:** `packages/mcp-server/public/` (deleted), `packages/mcp-server/src/http/routes.ts` (trimmed), `README.md`, `DEPLOYMENT.md`, integration READMEs.
- **Blocks:** T8.2
- **Blocked by:** T6.7

---

## Phase 8 — Docker Compose

### T8.1 — Dockerfiles for mcp-server and dashboard

- **Acceptance:** `docker/mcp-server.Dockerfile` and `docker/dashboard.Dockerfile` build multi-stage images. Node 22 slim runtime. `pnpm` install in builder stage, copy built output to runtime stage. Both images expose their respective ports and accept env vars (`LIBRARIAN_ADMIN_TOKEN`, `LIBRARIAN_AGENT_TOKEN`, `LIBRARIAN_DATA_DIR`, etc.). `docker build` succeeds for both.
- **Verify:**
  ```sh
  docker build -f docker/mcp-server.Dockerfile -t librarian-mcp:dev .
  docker build -f docker/dashboard.Dockerfile -t librarian-dashboard:dev .
  ```
- **Files:** `docker/{mcp-server,dashboard}.Dockerfile`, `.dockerignore`.
- **Blocks:** T8.2
- **Blocked by:** T6.7

### T8.2 — docker-compose.yml + DEPLOYMENT.md + compose-aware healthcheck

- **Acceptance:** `docker/docker-compose.yml` defines `mcp-server` and `dashboard` services with a shared `data` named volume mounted at the configured `LIBRARIAN_DATA_DIR`. `.env.example` lists every required env var. Container-level healthcheck per service. `DEPLOYMENT.md` shows the compose workflow as the recommended path; documents env vars; shows the rebuild-from-JSONL recovery procedure. **`pnpm healthcheck` grows a `--remote <url>` mode**: when supplied, instead of spawning its own MCP server it points at an existing URL, runs the MCP-reachability + auth checks against it, and skips the in-process checks (JSONL append, SQLite rebuild, session lifecycle — those don't make sense against a remote stack). CI uses the remote mode against the compose stack.
- **Verify:**
  ```sh
  cp .env.example .env && # set tokens
  docker compose -f docker/docker-compose.yml up -d
  pnpm healthcheck --remote http://127.0.0.1:3838    # passes against compose stack
  docker compose -f docker/docker-compose.yml down -v
  ```
- **Files:** `docker/docker-compose.yml`, `.env.example`, `DEPLOYMENT.md`, `scripts/healthcheck.ts` (`--remote` flag + remote-only check set).
- **Blocks:** T9.1
- **Blocked by:** T8.1

---

## Phase 9 — Polish

### T9.1 — CONTRIBUTING.md + key ADRs

- **Acceptance:** `CONTRIBUTING.md` covers: prerequisites, clone+install (under 5 minutes), workspace layout overview, dev workflow (`pnpm dev`), where to add what (new MCP tool, new tRPC procedure, new dashboard page, new CLI verb), test layering, lint/format/typecheck expectations, PR conventions (per `~/CLAUDE.md`), debugging tips. `docs/adr/` directory created with at least three ADRs: (1) separate services for MCP and dashboard, (2) tRPC for the dashboard admin API, (3) no `any`. ADR format: title, status, context, decision, consequences.
- **Verify:** A "stranger" walkthrough: read `CONTRIBUTING.md`; can you answer "where do I add a new MCP tool?" in under a minute? (Test by giving it to a fresh Claude Code session and asking.)
- **Files:** `CONTRIBUTING.md`, `docs/adr/{0001-separate-services,0002-trpc-admin-api,0003-no-any}.md`.
- **Blocks:** T9.2
- **Blocked by:** T8.2

### T9.2 — README polish + TODO/spec follow-up sweep

- **Acceptance:** `README.md` reflects the post-overhaul layout (workspace structure, `pnpm` commands, Docker quickstart, dashboard URL). `TODO.md` updated: items that the overhaul resolved are crossed off (dashboard REST auth, `/lib:session` straggler cleanup if it caught a sweep, etc.). Outstanding items from the spec's open questions or any new ones surfaced during the migration are added.
- **Verify:**
  ```sh
  # Manual: read the README and TODO end-to-end; cross-check claims against the actual tree.
  ```
- **Files:** `README.md`, `TODO.md`, possibly `specs/002-maintainability-overhaul.md` (status → "Implemented").
- **Blocks:** —
- **Blocked by:** T9.1

---

## Summary

| Phase | Tasks | Total |
|---|---|---|
| P1 Foundation | T1.1, T1.2, T1.3, T1.4 | 4 |
| P2 Relocation | T2.1 | 1 |
| P3 Core TS | T3.1, T3.2, T3.3, T3.4, T3.5 | 5 |
| P4 mcp-server TS + tRPC | T4.1, T4.2, T4.3, T4.4, T4.5, T4.6 | 6 |
| P5 CLI TS | T5.1, T5.2 | 2 |
| P6 Dashboard | T6.1, T6.2, T6.3, T6.4, T6.5, T6.6, T6.7 | 7 |
| P7 Retire old | T7.1 | 1 |
| P8 Docker | T8.1, T8.2 | 2 |
| P9 Polish | T9.1, T9.2 | 2 |
| **Total** | | **30** |

**30 PRs over 9 phases, executed serially.** Execution order: T1.1 → T1.2 → T1.3 → T1.4 → T2.1 → T3.1 → T3.2 → T3.3 → T3.4 → T3.5 → T4.1 → T4.2 → T4.3 → T4.4 → T4.5 → T4.6 → T5.1 → T5.2 → T6.1 → T6.2 → T6.3 → T6.4 → T6.5 → T6.6 → T6.7 → T7.1 → T8.1 → T8.2 → T9.1 → T9.2.

(The `Blocks` / `Blocked by` edges remain documented for future reference and as a safety net — if scope ever changes to involve a second agent, the parallelisation map in the plan and these edges show what could legitimately run concurrently. For now: one PR in flight at a time.)

**Possible mid-flight split:** T6.4 currently bundles five Memory tabs (analytics, proposals, conflicts, archive, logs) into one PR. If review or implementation surfaces it as too large, split into one PR per tab — that lands a more accurate total of 33–34 PRs.

## Next step

Once these tasks are reviewed and approved, implementation begins at **T1.1**. Each PR references the task ID and the spec phase. The Tasks doc updates only when a task is split, merged, or scope-changed during implementation.

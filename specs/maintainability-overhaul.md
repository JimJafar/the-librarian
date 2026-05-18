# Spec: Maintainability overhaul

## Status

Approved 2026-05-18.

## Objective

Restructure The Librarian so it is **a joy to maintain and extend**. Concretely: full TypeScript with strict types, a Next.js dashboard with Tailwind, lint + format + typecheck gating, a clean monorepo layout that makes module boundaries explicit, files small enough to read in one sitting, and a one-command Docker build for painless deployment.

The current codebase works but it has rough edges that compound: `src/store.js` is ~2,000 lines, the dashboard is hand-rolled vanilla JS + REST, there's no static type system, there's no formatter, there's no consistent module structure, and onboarding requires reading source rather than docs. None of this is failing in production — but every change costs more than it should.

**Success means:** a new contributor can clone, run `pnpm install && pnpm dev`, see the dashboard hot-reloading and the MCP server live in under a minute, find what they need to edit without grepping the whole tree, write code that auto-formats and type-checks on save, and land their first PR before lunch.

## Non-goals

- **Not changing the storage format.** `events.jsonl` and `sessions.jsonl` stay byte-compatible. Existing data carries forward.
- **Not changing the MCP protocol.** Tool surface, payload schemas, and behavior are identical so harness integrations (Hermes, Claude Code, Codex, OpenCode, Pi) do not break.
- **Not migrating off SQLite.** No Postgres, no Drizzle, no Prisma. Native `node:sqlite` stays the projection store.
- **Not switching runtime.** Node 22+ remains the runtime; not adopting Bun or Deno.
- **Not redesigning features.** No new tools, no new session verbs, no new visibility levels. The maintainability overhaul is structural only; feature work happens in separate specs.
- **Not adopting a heavy state management library** in the dashboard (Redux, Zustand, etc.). Server-side fetching via tRPC + React Query plus local component state covers everything we need.

## Decisions (resolved)

1. **Repo layout:** pnpm workspaces, four packages (`packages/core`, `packages/mcp-server`, `packages/cli`, `apps/dashboard`).
2. **MCP hosting:** separate services. The MCP server (stdio + HTTP) runs as its own process; the Next.js dashboard runs as another.
3. **Dashboard ↔ MCP API:** the MCP server exposes a tRPC admin API alongside `/mcp`. The dashboard is the tRPC client. The MCP server is the **sole writer** to the data directory.
4. **Migration:** incremental PRs. `main` stays releasable throughout; old and new coexist phase by phase.

## Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node 22+ | unchanged |
| Package manager | pnpm 9+ | replaces `npm` + `package-lock.json` |
| Language | TypeScript 5.x, `"strict": true`, no `any` | shared `tsconfig.base.json` |
| Test runner | Vitest 2.x | better TS support, watch mode, parallel; replaces `node --test` |
| Linter | ESLint 9 (flat config) + `@typescript-eslint` | |
| Formatter | Prettier 3 | runs via lint-staged pre-commit |
| Pre-commit hooks | Lefthook | no Node dep; faster than Husky |
| SQLite | `node:sqlite` (built-in) | unchanged; zero-dep stays a goal |
| Validation / schemas | Zod 3 | shared between MCP server tRPC router and dashboard |
| MCP server logging | pino + pino-pretty in dev | structured logs; bring `console.log` calls under control |
| Dashboard framework | Next.js 15 (App Router) | React 19, Server Components by default |
| Styling | Tailwind v4 | |
| Component primitives | shadcn/ui | Tailwind-native; copy-in components rather than runtime dep |
| RPC | tRPC v11 over HTTP | Next.js consumes the MCP server's tRPC endpoint |
| Server-side data fetching | React Query (via `@tanstack/react-query` + tRPC client) | for the client-side parts; Server Components fetch directly via the tRPC server-side caller |
| Container | Docker, Docker Compose | one compose file boots MCP server + dashboard + shared volume |

## Project Structure

```
.
├── apps/
│   └── dashboard/                     # @librarian/dashboard — Next.js App Router
│       ├── app/
│       │   ├── (memories)/page.tsx
│       │   ├── sessions/page.tsx
│       │   ├── sessions/[id]/page.tsx
│       │   ├── layout.tsx
│       │   └── globals.css
│       ├── components/
│       │   ├── ui/                    # shadcn/ui primitives
│       │   ├── memories/
│       │   └── sessions/
│       ├── lib/
│       │   ├── trpc-client.ts         # client-side tRPC + React Query
│       │   └── trpc-server.ts         # Server Component caller
│       ├── tailwind.config.ts
│       ├── next.config.mjs
│       ├── tsconfig.json
│       └── package.json
├── packages/
│   ├── core/                          # @librarian/core — pure storage + business logic
│   │   ├── src/
│   │   │   ├── store/                 # LibrarianStore decomposed
│   │   │   │   ├── memory-store.ts
│   │   │   │   ├── session-store.ts
│   │   │   │   ├── projection.ts      # SQLite rebuild paths
│   │   │   │   ├── jsonl.ts           # JSONL read/append helpers
│   │   │   │   └── index.ts
│   │   │   ├── schemas/               # Zod schemas (source of truth for types)
│   │   │   │   ├── memory.ts
│   │   │   │   ├── session.ts
│   │   │   │   └── index.ts
│   │   │   ├── formatters/            # prose/markdown renderers for handovers
│   │   │   ├── constants.ts
│   │   │   └── index.ts
│   │   ├── tests/                     # Vitest mirrors src/ layout
│   │   ├── tsconfig.json
│   │   └── package.json
│   ├── mcp-server/                    # @librarian/mcp-server — stdio + HTTP MCP + tRPC admin
│   │   ├── src/
│   │   │   ├── bin/
│   │   │   │   ├── stdio.ts           # `librarian-mcp-stdio` entry
│   │   │   │   └── http.ts            # `librarian-mcp-http` entry (replaces dashboard.js HTTP service)
│   │   │   ├── mcp/
│   │   │   │   ├── dispatch.ts        # one tool per file under tools/
│   │   │   │   ├── tools/
│   │   │   │   │   ├── start-session.ts
│   │   │   │   │   ├── list-sessions.ts
│   │   │   │   │   ├── … (one file per MCP tool)
│   │   │   │   ├── visibility.ts
│   │   │   │   └── index.ts
│   │   │   ├── trpc/
│   │   │   │   ├── router.ts          # AppRouter export — dashboard imports its type
│   │   │   │   ├── sessions.ts
│   │   │   │   ├── memories.ts
│   │   │   │   └── context.ts         # store, auth context
│   │   │   ├── http/                  # request handling, auth middleware
│   │   │   └── index.ts
│   │   ├── tests/
│   │   ├── tsconfig.json
│   │   └── package.json
│   └── cli/                           # @librarian/cli — `the-librarian` binary
│       ├── src/
│       │   ├── bin.ts                 # `#!/usr/bin/env node` entry
│       │   ├── commands/              # one file per verb (sessions-start.ts, sessions-list.ts, …)
│       │   ├── runtime.ts             # runCli function (testable)
│       │   └── index.ts
│       ├── tests/
│       ├── tsconfig.json
│       └── package.json
├── integrations/                      # unchanged
├── docs/                              # unchanged
├── specs/                             # unchanged
├── scripts/
│   └── healthcheck.ts                 # ported from .js
├── docker/
│   ├── mcp-server.Dockerfile
│   ├── dashboard.Dockerfile
│   └── docker-compose.yml
├── data/                              # gitignored, mounted into containers
├── .github/
│   └── workflows/ci.yml               # lint, typecheck, test, build
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── eslint.config.mjs                  # flat config
├── .prettierrc
├── lefthook.yml
├── package.json                       # workspace root
├── README.md
├── CONTRIBUTING.md                    # new — joy-to-onboard guide
└── TODO.md                            # unchanged (carried forward)
```

### Dependency direction

```
@librarian/core   ←  @librarian/mcp-server  ←  @librarian/cli
                  ←  @librarian/mcp-server  ←  @librarian/dashboard (imports AppRouter type only)
```

- `core` depends on **nothing internal**. It exports pure storage + schemas.
- `mcp-server` depends on `core`. Exports its tRPC `AppRouter` *type* (not the runtime).
- `cli` depends on `core` directly (CLI calls store methods locally; no MCP round-trip).
- `dashboard` depends on `mcp-server` for the `AppRouter` *type only* and calls the tRPC endpoint over HTTP at runtime. Dashboard never imports `core` (would risk a second SQLite connection).

This is enforced by:
- Per-package `package.json` `dependencies` (only the allowed siblings)
- An ESLint rule (`import/no-restricted-paths` or a custom plugin) that fails the build if `dashboard` imports from `core`

## Commands

```sh
pnpm install                    # bootstrap workspaces
pnpm dev                        # boot MCP server + dashboard with hot reload
pnpm build                      # build all packages (tsc + next build)
pnpm test                       # all tests across all packages (Vitest)
pnpm test:sessions              # session-focused tests only (parity with current)
pnpm lint                       # ESLint, all packages
pnpm typecheck                  # tsc --noEmit, all packages
pnpm format                     # prettier --write
pnpm healthcheck                # ported from scripts/healthcheck.js

# per-package, when needed
pnpm --filter @librarian/cli build
pnpm --filter @librarian/dashboard dev

# production-style local boot
docker compose -f docker/docker-compose.yml up -d
docker compose -f docker/docker-compose.yml logs -f
docker compose -f docker/docker-compose.yml down
```

## Code Style

TypeScript strict; no `any`; explicit return types on all exported functions; named exports (no default exports except where a framework requires them, e.g. Next.js page components).

Example (the kind of thing each file should look like):

```ts
// packages/core/src/store/session-store.ts
import { eventEmitter } from "./jsonl.js";
import type { Session, SessionEvent, StartSessionInput } from "../schemas/session.js";

export interface SessionStore {
  start(input: StartSessionInput): { session: Session };
  get(id: string): Session | null;
  list(filters: ListSessionsFilters): ListSessionsResult;
  // …
}

export function createSessionStore(deps: SessionStoreDeps): SessionStore {
  const { db, appendEvent, now } = deps;
  return {
    start(input) {
      const session = buildSession(input, now());
      appendEvent({ type: "session.started", session_id: session.id, payload: { session } });
      return { session };
    },
    get(id) {
      const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
      return row ? rowToSession(row) : null;
    },
    // …
  };
}
```

Conventions:

- **One concern per file.** Files cap at ~400 LOC. Functions cap at ~50 LOC (soft).
- **Function-style modules.** Prefer `createX(deps)` factories over classes. Class is fine when shape genuinely needs `new` (e.g. `LibrarianStore` continues to be a class for the public surface, but its guts are factored into composable function modules).
- **Imports sorted** by `eslint-plugin-import` / Prettier import order.
- **Path aliases** (`@/`) within each package only. No cross-package aliases (use the package name).
- **No barrel files that re-export everything** — explicit imports keep tree-shaking honest and make dependencies legible. A package's `index.ts` re-exports only the public surface.
- **JSDoc/TSDoc on exported types and functions** that are non-obvious. No comments on self-evident code (per the existing house style).
- **Errors are typed** where they carry data the caller acts on; otherwise plain `Error` with a clear message and (optionally) a `hint` field (matching the healthcheck pattern).

## Testing Strategy

- **Runner: Vitest.** Each package has its own `vitest.config.ts`. `pnpm test` runs all; `pnpm --filter <pkg> test` runs one. (Open question — see below.)
- **Test layout mirrors source.** `src/store/session-store.ts` ↔ `tests/store/session-store.test.ts`.
- **All current 177 tests port over.** No coverage regression at any phase. Tests convert file-by-file as their source modules convert.
- **Three levels:**
  - Unit — pure functions and store methods (vast majority)
  - Integration — full HTTP MCP + tRPC round-trips (in-process via supertest or Vitest's `request`)
  - E2E — light Playwright pass for the dashboard (Memories list renders, Sessions tab + detail panel render, archive/restore round-trip). Optional, gated on whether we want browser tests in CI.
- **Coverage** is not gated, but `pnpm test --coverage` works.

## Boundaries

### Always
- TypeScript `"strict": true`. Zero `any`.
- Lint passes (`pnpm lint`) — CI gates this.
- Typecheck passes (`pnpm typecheck`) — CI gates this.
- Pre-commit hook runs ESLint, Prettier, and `tsc --noEmit` on staged files.
- Storage format unchanged — `events.jsonl` and `sessions.jsonl` always backward compatible.
- MCP tool wire format unchanged — schemas locked to Zod definitions in `@librarian/core`.
- Single writer to the data directory — only `@librarian/mcp-server` opens `librarian.sqlite` for writes.
- New work goes through PR (per `~/CLAUDE.md`).

### Ask first
- Adding a new top-level package or `apps/` entry.
- Adding a runtime dependency (vs a dev dep).
- Changing public types exported from `@librarian/core`.
- Changing the tRPC `AppRouter` shape (it's a contract with the dashboard).
- Touching the JSONL ledger format (additive payload fields are fine; renaming or removing is not).
- CI/CD pipeline changes.

### Never
- Open SQLite for writes from more than one process.
- Commit `data/`, `.env`, or any local secrets.
- Ship code with TS `any`, `// @ts-ignore`, or `eslint-disable` without a comment naming the reason.
- Force-push to `main` or any other shared branch.
- Delete or rename files in `integrations/<harness>/commands/` without updating the harness's package README (those are user-facing).

## Success Criteria

The overhaul is done when **all** of these are true:

1. `pnpm install && pnpm dev` boots the MCP server (stdio + HTTP) and the Next.js dashboard with hot reload in under 30 seconds on a clean machine.
2. `docker compose up -d` produces a working dashboard at the documented port, with `/mcp` reachable and authenticated, against a mounted `data/` volume.
3. `pnpm test` runs all tests (porting the existing 177 + any new) and they pass on CI.
4. `pnpm lint`, `pnpm typecheck`, `pnpm format --check` all pass on `main`. CI gates each.
5. No file in `packages/` or `apps/` exceeds 400 LOC. `store.ts` is decomposed into focused modules under `packages/core/src/store/`.
6. Zero `any`, zero `@ts-ignore` without an inline comment naming the reason and a ticket / TODO reference.
7. Dependency directions are enforced (ESLint rule + per-package `dependencies`) — the dashboard cannot import from `@librarian/core`.
8. Pre-commit hook prevents commits that fail lint/format/typecheck.
9. The dashboard matches feature parity with the current vanilla-JS dashboard: Memories tab (browse + filters + analytics + proposals + conflicts + archive + logs), Sessions tab (list + detail + lifecycle + handover + promote-to-memory).
10. Harness integration packages still work unchanged. The `the-librarian` CLI binary keeps its current verb surface; existing wrapper scripts pass their healthchecks against the new build.
11. `CONTRIBUTING.md` is good enough that a stranger can clone, run dev, find the right file for a hypothetical change, write a test, and submit a PR — all without reading source code beyond the file they're editing.
12. `README.md` is updated to point at the new commands and layout.

## Migration plan (phases)

Each phase is one or more PRs. Each phase leaves `main` releasable. The old code coexists with the new until the corresponding cutover phase.

### Phase 1 — Foundation
Add tooling alongside existing JS without breaking anything.

- pnpm workspaces scaffold: `pnpm-workspace.yaml`, root `package.json` with workspace scripts
- `tsconfig.base.json` (strict) and per-package `tsconfig.json` files (still empty packages)
- ESLint flat config (`eslint.config.mjs`) with `@typescript-eslint`, `import`, `unicorn`, `vitest` plugins
- Prettier (`.prettierrc`)
- Lefthook pre-commit (lint, format, typecheck on staged)
- Vitest installed at the root; runs the existing `.js` tests via `--test` glob compat OR keep node:test for now and migrate per-file in phase 2 (TBD in phase planning)
- CI workflow: `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build`
- `CONTRIBUTING.md` skeleton (will fill in as we go)

**Checkpoint:** existing `npm test` / `npm run smoke` / `npm run healthcheck` still pass; new `pnpm lint` passes on the empty TS config; CI green.

### Phase 2 — Relocate source into packages (still JS)
Move files into the workspace layout without rewriting them.

- `src/store.js` → `packages/core/src/store.js`
- `src/server.js` → `packages/mcp-server/src/bin/stdio.js`
- `src/dashboard.js` → `packages/mcp-server/src/bin/http.js`
- `src/mcp.js` → `packages/mcp-server/src/mcp/dispatch.js`
- `src/cli.js` → `packages/cli/src/cli.js` + `packages/cli/src/bin.js`
- `src/constants.js` → `packages/core/src/constants.js`
- Tests follow their source files into the matching package
- `public/` → `packages/mcp-server/public/` (temporarily; gets retired in phase 5)
- `package.json` `bin` field moves to the CLI package; root delegates via workspace scripts

**Checkpoint:** `pnpm test`, `pnpm --filter @librarian/mcp-server start`, `pnpm --filter @librarian/cli ...` all work. No behavior change.

### Phase 3 — Port `@librarian/core` to TypeScript
Decompose `store.js` and add types.

- Zod schemas in `packages/core/src/schemas/` (source of truth for `Memory`, `Session`, `SessionEvent`, payload types)
- Split `store.js` into focused modules under `src/store/` (memory store, session store, projection, jsonl, formatters)
- Existing public surface (`LibrarianStore` class) remains as a thin facade over the new modules — no caller changes
- Tests in this package port file-by-file: `store.test.js` becomes several focused `*.test.ts` files
- Public API exports tightly controlled via `src/index.ts`

**Checkpoint:** `pnpm --filter @librarian/core test` passes; `pnpm --filter @librarian/core build` produces clean d.ts; downstream packages still import the same names.

### Phase 4 — Port `@librarian/mcp-server` to TypeScript + add tRPC
The MCP HTTP service grows a tRPC admin API.

- TS port of the existing dispatch, HTTP handling, auth middleware
- One file per MCP tool under `src/mcp/tools/`
- New `src/trpc/router.ts` defining the tRPC `AppRouter` (read/write procedures for memories + sessions, mirroring current REST + adding the lifecycle ops)
- The existing `/api/*` REST endpoints stay live during this phase — old dashboard keeps working
- pino logging replaces console.log
- The HTTP service gains a `/trpc/*` mount and a `/mcp` mount on the same server
- Tests port and add tRPC procedure tests

**Checkpoint:** old dashboard (`packages/mcp-server/public/`) still works; new tRPC endpoint passes integration tests; both `/mcp` and `/trpc/*` reachable on the same server.

### Phase 5 — Port `@librarian/cli` to TypeScript
- TS port of the CLI dispatcher and per-verb command files
- Each verb in its own file under `src/commands/`
- Tests port; verb surface and flag shapes unchanged
- The shipped binary path stays `the-librarian` (still works for every wrapper script in `integrations/`)

**Checkpoint:** `pnpm --filter @librarian/cli build` produces a working binary; all existing integration wrapper scripts pass their healthchecks unchanged.

### Phase 6 — Build the Next.js dashboard
Greenfield UI matching the current dashboard's features.

- `apps/dashboard/` scaffold: Next.js 15 App Router, Tailwind v4, shadcn/ui init
- tRPC client wired to the MCP server's `/trpc` endpoint
- Routes:
  - `/` — Memories (browse + filters + analytics + proposals + conflicts + archive + logs)
  - `/sessions` — Sessions list (current Sessions tab as a full page)
  - `/sessions/[id]` — Session detail (current detail panel as a route)
- Server Components for read-side; Server Actions (calling tRPC) for write-side
- Auth: shared admin bearer token with the MCP server's `/trpc` endpoint (operator runs the dashboard)
- Light Playwright pass: Memories list renders, Sessions list renders, archive/restore round-trip, promote-to-memory form submits

**Checkpoint:** new dashboard ships on a different port (or path prefix) alongside the old one; visual + functional parity verified manually. README documents both.

### Phase 7 — Retire the old dashboard
- Remove `packages/mcp-server/public/`
- Remove `packages/mcp-server/src/bin/http.js` HTML serving routes (only `/mcp` + `/trpc` + `/healthz` remain on the MCP server)
- Remove the legacy `/api/*` REST endpoints (the new dashboard is fully on tRPC)
- Update integration package docs to point at the new dashboard URL if it moved
- Update `README.md`, `DEPLOYMENT.md`

**Checkpoint:** clean tree; only one dashboard ships; old REST surface gone.

### Phase 8 — Docker Compose
- `docker/mcp-server.Dockerfile`: multi-stage build → Node slim runtime, `bin/http.js` as entry
- `docker/dashboard.Dockerfile`: multi-stage build → Next.js standalone output
- `docker/docker-compose.yml`: both services + shared `data/` volume + env file
- Healthchecks per service
- Update `DEPLOYMENT.md` to show the compose flow as the recommended path

**Checkpoint:** `docker compose up -d` from a clean checkout produces a working dashboard + MCP HTTP service, with data persisted across restarts.

### Phase 9 — Polish + docs
- Fill out `CONTRIBUTING.md`
- Add a couple of ADRs for the non-obvious decisions (separate services, tRPC over REST, no `any`)
- Update `~/CLAUDE.md`'s Librarian section if it needs to mention the new repo layout
- Cross off TODO.md items resolved as a side-effect of the overhaul (dashboard auth gets resolved naturally if we land tRPC auth)
- Clean up any straggler `.js` files and `.eslintignore` entries

**Checkpoint:** success criteria #1–#12 all met. Spec is closed.

## Resolved decisions

(Open at draft time; resolved during 2026-05-18 review.)

1. **Test runner: Vitest.** Migrating off `node:test` is itself part of the overhaul. Vitest's TS DX, watch mode, and parallel runs are worth it.
2. **Component library: shadcn/ui.** Components live in the repo (no runtime dep); accessibility baseline comes for free.
3. **Pre-commit hooks: Lefthook.** No Node dep during `pnpm install`, faster than Husky.
4. **SQLite driver: `node:sqlite`.** Built-in, zero-dep. Revisit only if we hit a concrete blocker.
5. **Logging: pino** at the MCP server level (NDJSON to stdout). CLI stays console-style. Dashboard logs via Next.js conventions.
6. **Dashboard auth: reuse `LIBRARIAN_ADMIN_TOKEN`.** The dashboard is an operator tool; no need for a separate token.
7. **`AppRouter` type lives in `@librarian/mcp-server`,** exported as a type-only export. Dashboard's `package.json` lists `@librarian/mcp-server` as a `devDependency` (for the type) and never imports the runtime. ESLint rule enforces this.
8. **Formatters belong in `@librarian/core`** so the CLI and the MCP server render handovers the same way.
9. **CI provider: GitHub Actions** (matches the existing `.github/workflows/` directory).
10. **Lockfile transition:** `package-lock.json` → `pnpm-lock.yaml` in a single commit during Phase 1. Anyone with a checked-out `node_modules` should delete it after pulling. README will call this out.

## Acceptance review (for this spec)

Before any code lands, this spec should:

- Resolve the open questions above (or explicitly defer them with reasons).
- Be approved by Jim.
- Be referenced from each implementation PR ("implements Phase N of `specs/maintainability-overhaul.md`").

Once approved, the next artifacts are a **plan** (technical dependencies + checkpoints) and **tasks** (per-PR breakdown of each phase). Those land separately as the gated workflow advances.

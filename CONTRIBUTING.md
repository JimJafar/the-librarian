# Contributing to The Librarian

Thanks for picking this up. The codebase is small enough that you should be productive in under an hour. This guide is the fastest path to "I know where to add my thing."

## Prerequisites

- **Node 22.5 or newer.** We rely on the built-in `node:sqlite`, which lands properly in 22.5.
- **pnpm 9.15.x.** Bootstrapped via Corepack:

  ```sh
  corepack enable
  corepack prepare pnpm@9.15.0 --activate
  ```

- **Docker + Docker Compose** (optional, but required to run the production-shaped stack from `docker/docker-compose.yml`).
- A POSIX shell (zsh, bash). Scripts assume the usual `find`/`grep`/`openssl`.

## Clone + install (under 5 minutes)

```sh
git clone git@github.com:JimJafar/the-librarian.git
cd the-librarian
corepack enable && corepack prepare pnpm@9.15.0 --activate
pnpm install
pnpm run seed              # writes sample memories/sessions into ./data
```

Verify everything is wired up:

```sh
pnpm run healthcheck       # 5/5 checks: JSONL append, SQLite rebuild, lifecycle, stdio MCP, HTTP MCP+auth
pnpm test                  # full test suite (Vitest across all packages + root test/)
```

Run the stack locally (two services):

```sh
pnpm run serve                              # mcp-server at http://127.0.0.1:3838
pnpm --filter @librarian/dashboard dev      # dashboard at http://127.0.0.1:3000
```

The dashboard reads `LIBRARIAN_SERVER_URL` (defaults to `http://127.0.0.1:3838`) and `LIBRARIAN_ADMIN_TOKEN` from env. Without an admin token, tRPC procedures return 401 — set `LIBRARIAN_ADMIN_TOKEN=dev-admin-token` in the env that starts both services.

## Workspace layout

```text
the-librarian/
├── apps/
│   └── dashboard/         # Next.js 14 admin UI (port 3000)
├── packages/
│   ├── core/              # Storage engine, schemas, formatters (no I/O outside the data dir)
│   ├── mcp-server/        # /mcp JSON-RPC, /trpc/* admin API, /healthz (port 3838)
│   └── cli/               # `the-librarian` binary (sessions verbs, seed, rebuild)
├── scripts/               # healthcheck, smoke, guards (test-count, storage-fixture, schema-version)
├── test/                  # cross-cutting Vitest tests (healthcheck script, integrations)
├── docker/                # mcp-server.Dockerfile, dashboard.Dockerfile, docker-compose.yml
├── docs/
│   ├── adr/               # Architecture decision records
│   └── slash-commands.md  # Cross-harness /lib:session contract
├── integrations/          # Per-harness setup packages (Hermes, Claude Code, Codex, OpenCode, Pi)
├── skills/                # Reusable agent skill describing the memory protocol
└── specs/                 # Long-form specs the overhaul phases reference
```

### Data flow at a glance

```
   agent ──────────►  mcp-server (3838)
   (bearer token)        │   /mcp        ┐
                         │   /trpc/*     │── @librarian/core ──► ./data/{events,sessions}.jsonl  (canonical)
                         │   /healthz    │                       ./data/librarian.sqlite        (rebuildable projection)
                                         ┘                       ./data/memories.md             (snapshot)
                            ▲
                            │ admin-token bearer (server-side only)
                            │
   browser ────►  dashboard (3000)
                      │  Server Actions   ───► mcp-server tRPC (direct, server-side)
                      │  Browser tRPC     ───► /api/trpc/[trpc] same-origin proxy ───► mcp-server tRPC
```

The JSONL ledgers are the source of truth. SQLite is a rebuildable projection — `pnpm rebuild` or restarting the mcp-server with `librarian.sqlite` missing replays both ledgers into a fresh index. See [`docs/adr/0001-separate-services.md`](./docs/adr/0001-separate-services.md) and [`docs/adr/0002-trpc-admin-api.md`](./docs/adr/0002-trpc-admin-api.md) for the architecture decisions behind this split.

## Where to add what

### A new MCP tool

1. Define the input/output schema in `packages/mcp-server/src/mcp/tools/schemas.ts` (Zod, derived from the core enums where possible).
2. Add a handler file under `packages/mcp-server/src/mcp/tools/<name>.ts`. Export a `ToolDefinition` whose `handler` takes a `ToolContext` and returns either text or a structured result.
3. Register it in `packages/mcp-server/src/mcp/tools/index.ts`.
4. If the tool is admin-only, set `adminOnly: true` on the definition.
5. Write tests under `packages/mcp-server/tests/mcp/<name>.test.ts` that go through the dispatch layer.

The MCP dispatcher (`dispatch.ts`) is intentionally <100 LOC — every behaviour lives in the per-tool file.

### A new tRPC procedure

1. Pick the namespace: `memories` (in `packages/mcp-server/src/trpc/memories.ts`) or `sessions` (in `sessions.ts`). New namespaces go in their own file and are wired into `router.ts`.
2. Add the procedure under `adminProcedure`. Inputs are Zod schemas; output types are inferred.
3. Map store errors to `TRPCError` codes (`NOT_FOUND`, `BAD_REQUEST`, etc.) — keeps HTTP status codes correct.
4. Write tests under `packages/mcp-server/tests/trpc/<namespace>.test.ts`.

If the dashboard needs it, the type flows automatically: `apps/dashboard/lib/trpc-client.ts` (browser) and `lib/trpc-server.ts` (Server Actions) both import `AppRouter` from `@librarian/mcp-server`.

### A new dashboard page

1. Add a route under `apps/dashboard/app/<segment>/page.tsx` (Next.js App Router).
2. Read via the server-side tRPC client (`createServerTRPC` in `lib/trpc-server.ts`) inside the server component. Pass data to client components as props.
3. Writes: define a Server Action in `app/<segment>/actions.ts` (or a colocated `actions.ts` inside a route group). Call the server-side tRPC client and `revalidatePath` on success.
4. UI primitives live under `apps/dashboard/components/ui/` (shadcn). Feature components go under `components/<feature>/`.
5. Write a Vitest + RTL component test under `apps/dashboard/tests/components/<name>.test.tsx`. Playwright e2e is for end-to-end happy paths only; prefer component tests.

### A new CLI verb

1. Add a command file under `packages/cli/src/commands/<verb>.ts`.
2. Register it in `packages/cli/src/commands/index.ts`.
3. Reuse `parse-flags.ts` for flag handling; reuse formatters from `@librarian/mcp-server` for output that should match the slash-command surface.
4. Tests: snapshot the help text in `tests/snapshots.test.ts`; behavioural tests in `tests/cli.test.ts`.

## Test layering

We use Vitest exclusively. The pyramid:

- **Unit + integration tests** (per-package, `tests/`) — most of the suite. Hit the store directly or go through dispatch/router.
- **Component tests** (`apps/dashboard/tests/components/`) — Vitest + RTL + jsdom. Prefer these over Playwright when feasible.
- **Playwright e2e** (`apps/dashboard/e2e/`) — golden-path coverage only. Runs as its own CI job.

The `pnpm test` script chains: build everything → run each package's Vitest config → run the root `test/` config. Workspace-wide totals are floored by `scripts/check-test-count.mjs` (currently ≥ 177).

## Lint / format / typecheck

```sh
pnpm run lint              # ESLint flat config across the workspace
pnpm run format            # Prettier write
pnpm run format:check      # Prettier check (CI)
pnpm run typecheck         # tsc --noEmit per package
pnpm run build             # tsc per package + Next.js build for the dashboard
```

Lefthook runs the lint + prettier on staged files in `pre-commit` (configured in `lefthook.yml`). Don't bypass with `--no-verify` unless you understand what you're skipping.

## Quality gates (PR-level)

- **400 LOC per file (production source).** Tests are exempt. If a file gets close, look for an extraction. This is a PR-template checkbox; CI doesn't enforce it.
- **No `any`, no `@ts-ignore` in production source.** See [`docs/adr/0003-no-any.md`](./docs/adr/0003-no-any.md). One `any` is allowed in test helpers with an inline disable + rationale.
- **Test-count floor.** `scripts/check-test-count.mjs` rejects PRs that drop below the workspace baseline.
- **Storage compatibility fixture.** `scripts/check-storage-fixture.mjs` re-projects a frozen pre-migration JSONL fixture into SQLite and checks the row counts match. Any change to the projection logic that breaks this fixture must explicitly migrate the fixture and bump the schema sentinel.
- **Schema-version sentinel.** `scripts/check-schema-version.mjs` keeps the projection schema version in sync with the migration the code emits.

## PR conventions

Follow the user's repo-wide PR conventions in `~/.claude/CLAUDE.md` if you're contributing through a Claude Code agent. In short:

- **Conventional Commits** for messages: `<type>(<scope>): <description>` where `<type>` is one of `fix`, `feat`, `chore`, `test`, `style`, `refactor`, and `<scope>` matches the workspace touched (e.g. `feat(mcp-server): …`, `refactor(core): …`).
- **PR title** under 70 characters. Detail goes in the body.
- **Body sections**: `Summary` (what + why) and `Test plan` (a checklist of what you verified).
- Open as **Draft** if it's not ready for review.
- Use `gh pr merge --rebase --delete-branch`; squash and merge-commit are blocked on this repo.
- Reviewer-bot findings get amended in the same PR before merge.

## Debugging tips

- **MCP dispatch issues.** `packages/mcp-server/src/mcp/dispatch.ts` is intentionally tiny — any tool-specific logic lives in its `tools/<name>.ts` file. Add a console-style log via `logger` from `packages/mcp-server/src/logging.ts` (pino) rather than `console.log`.
- **tRPC 401s.** First check `LIBRARIAN_ADMIN_TOKEN` is set in the process running the dashboard or test. The `trpc-server.ts` module logs a one-liner on cold start if it's missing.
- **SQLite "experimental" warnings.** Expected — `node:sqlite` is experimental in Node 22. Suppress with `--no-warnings` in production-style scripts (`pnpm run serve` does this).
- **`fail to load url sqlite`** in a new Vitest config. Vite 5's SSR transformer strips the `node:` prefix from `node:sqlite`. The fix lives in `vitest.config.ts` / `packages/core/vitest.config.ts`: externalise the `@librarian/core` dist tree.
- **Dashboard build failures referencing `@librarian/mcp-server` types.** Run `pnpm --filter @librarian/core --filter @librarian/mcp-server run build` first; the dashboard imports `AppRouter` types from the compiled `dist/`.
- **Healthcheck against a deployed instance.** `pnpm healthcheck -- --remote http://host:3838 --agent-token <t>` skips the in-process checks and only probes the remote URL.

## Where to read next

- [`docs/adr/`](./docs/adr/) — architecture decisions: the two-service split, tRPC, the `any` ban.
- [`specs/done/maintainability-overhaul.md`](./specs/done/maintainability-overhaul.md) — what the 30-PR overhaul was solving and why.
- [`specs/done/session-layer-and-harness-packages.md`](./specs/done/session-layer-and-harness-packages.md) — the original session-layer contract that drove the harness integrations (implemented; partially superseded — see header).
- [`docs/slash-commands.md`](./docs/slash-commands.md) — the cross-harness `/lib:session` surface.
- [`DEPLOYMENT.md`](./DEPLOYMENT.md) — operating the compose stack on a personal VPS.

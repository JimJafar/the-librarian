# Plan: Maintainability overhaul

Companion to [`specs/maintainability-overhaul.md`](./maintainability-overhaul.md). The spec defines **what** and **why**; this plan defines **how**, in what **order**, what's parallelisable, what the **risks** are, and how each phase is **verified**.

## Status

Draft for review.

## Component dependency graph

```
                  ┌─────────────────┐
                  │  Tooling (P1)   │
                  │  pnpm, TS, ESL  │
                  │  Vitest, hooks  │
                  └────────┬────────┘
                           │
                  ┌────────▼────────┐
                  │ Relocation (P2) │
                  │ src/ → packages │
                  └────────┬────────┘
                           │
                  ┌────────▼────────┐
                  │ @librarian/core │  (P3 — TS port + decompose)
                  │ store, schemas, │
                  │ formatters      │
                  └─┬───────────┬───┘
                    │           │
        ┌───────────▼─┐       ┌─▼──────────────┐
        │ mcp-server  │       │ cli            │  ← P5 can start as soon as
        │ (P4)        │       │ (P5)           │     P3 lands; runs parallel
        │ /mcp +/trpc │       │ verbs, runtime │     to P4
        └─────────┬───┘       └────────────────┘
                  │
        ┌─────────▼───────┐
        │ apps/dashboard  │  (P6 — needs AppRouter type from P4)
        │ Next.js + tRPC  │
        │ Memories +Sess. │
        └─────────┬───────┘
                  │
        ┌─────────▼───────┐
        │ Retire old (P7) │
        │ remove public/  │
        │ + /api/* REST   │
        └─────────┬───────┘
                  │
        ┌─────────▼───────┐
        │ Docker (P8)     │  (could start in parallel with P6 if MCP server is
        │ compose, dockf  │   stable; needs both services to actually compose-up)
        └─────────┬───────┘
                  │
        ┌─────────▼───────┐
        │ Polish (P9)     │
        │ docs, ADRs      │
        └─────────────────┘
```

## Execution mode

**Solo, serial.** One PR in flight at a time, walking the critical path. The parallelisation map below is retained as a safety net for the (currently unplanned) case where a second agent joins; it does not drive day-to-day execution.

## What could run in parallel (reference only)

| Pair / set | Parallelisable? | Reason |
|---|---|---|
| P1 + P2 | Yes, partly | Tooling setup is mostly independent of file locations; can do `pnpm` scaffold + ESLint config + Lefthook before moving files. Final relocation needs the workspace layout in place. |
| P3 vs P4/P5 | **No.** | `core`'s public types are imported by `mcp-server` and `cli`. P3 must land before P4/P5 to avoid double-porting. |
| P4 + P5 | **Yes.** | Independent consumers of `core`. Could ship in either order, or both in flight at once on separate branches if a second agent is available. |
| P6 vs P4 | **Partly.** | T6.1 (scaffold + Tailwind/shadcn) is purely UI scaffolding and can start during P4. T6.2 onward (tRPC client + page work) needs T4.3 (tRPC scaffold) to be live. |
| P7 vs P6 | **No.** | Can't retire the old dashboard until the new one ships and matches feature parity. |
| P8 vs P4/P6 | **No.** | Originally noted as "Dockerfile during P4" — retracted. The mcp-server Dockerfile depends on a stable entrypoint location and env-var contract; if it lands mid-P4, later P4 PRs that move the bin or rename env vars silently rot it. Defer Dockerfiles until P4 fully closes. |
| P9 | Throughout | `CONTRIBUTING.md` grows across phases; ADRs land as decisions get made. |

## Risks and mitigations per phase

### Phase 1 — Foundation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Lefthook pre-commit hooks block all commits if too strict from day one | medium | high | Land hooks as `pre-commit` running only `prettier --check` first. Tighten to lint + typecheck once those pass cleanly across the moved tree. |
| ESLint flat config + plugin compatibility issues | medium | medium | Pin plugin versions; smoke-test on the existing `src/` (still JS) — must pass with zero errors before P2. |
| pnpm `workspaces` introduces install/run regressions vs npm | low | high | Keep `package.json` `scripts` working as fall-back during P1. CI runs both `pnpm test` and `npm test` for one PR to catch divergence. |
| Vitest test imports break against existing `.js` files | medium | medium | Phase 1 doesn't convert tests yet — Vitest can run `.test.js` files via its CJS/ESM interop. Tests convert in P3+. |

### Phase 2 — Relocate source into packages

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Import paths break (tests can't find modules) | high | medium | Single atomic PR per package move. Run `pnpm test` after each move. Avoid path renames inside files — only directory moves. |
| Binary paths break (the-librarian CLI, integration wrappers) | medium | high | Update `package.json` `bin` field in the same PR. Run `pnpm install` to regenerate symlinks. Test by running an integration wrapper. |
| `public/` (old dashboard assets) gets misplaced | low | low | Move to `packages/mcp-server/public/` explicitly; will be retired in P7 anyway. |

### Phase 3 — Port @librarian/core to TS

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Decomposing `store.js` into modules introduces subtle behavior changes | high | high | Public `LibrarianStore` class surface stays identical (same method names, same return shapes). Tests drive correctness — if a test breaks, the port is wrong. Don't refactor behavior, only structure. |
| Zod schema drift from the implicit types in `constants.js` | medium | medium | Generate schemas from the actual data first (read a few real JSONL events into a script that infers shape). Confirm against the spec's data model section. |
| Increase in cognitive load if module split is too granular | medium | low | Aim for 4–6 modules in `src/store/`, not 15. Each module is one cohesive concept (memory CRUD, session lifecycle, projection, JSONL I/O, formatters). |

### Phase 4 — Port mcp-server + add tRPC

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Co-mounting `/mcp` (JSON-RPC) and `/trpc/*` on the same HTTP server has routing edge cases | medium | high | Use a tiny router (express, hono, or hand-rolled — current code is hand-rolled `http.createServer`). Land the tRPC mount in a separate PR from the TS port so each can be reverted independently. |
| Visibility / auth logic duplicated between MCP dispatch and tRPC | high | medium | Both paths call shared middleware in `packages/mcp-server/src/http/auth.ts`. tRPC `context` resolves the same `role` + `agentId` the MCP dispatcher uses. |
| pino logging changes log format → breaks any downstream log scraping | low | low | Document the format change in the PR; ship pino-pretty in dev so the human-readable view stays similar. |
| tRPC procedures duplicate validation logic already in MCP tool handlers | medium | medium | Both use the same Zod schemas from `@librarian/core`. The dispatch layer is the only place validation lives; procedures and tool handlers are thin wrappers. |

### Phase 5 — Port CLI to TS

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `the-librarian` binary path or verb shape changes break integration wrapper scripts | medium | high | Healthcheck for each integration package's wrapper (Hermes, Claude Code, Codex, OpenCode, Pi). Run them all in CI for this phase's PR. |
| Per-verb file split (current `cli.js` is one file) introduces argv-parsing inconsistencies | low | medium | Share `parseFlags` in `src/runtime.ts`; each command file does only verb-specific stuff. Snapshot tests against `--help` output. |

### Phase 6 — Build the Next.js dashboard

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| New dashboard misses subtle behaviors of the old one (filter combinations, sort edge cases, conflict view) | high | high | Explicit feature-parity checklist in the PR. Manual side-by-side run with old (`packages/mcp-server/src/bin/http.js`) still serving. e2e Playwright tests for the headline flows. |
| Server Components calling tRPC server-side caller vs HTTP from the client gets confusing | medium | medium | Settle the rule early: read-side is RSC + server-side tRPC caller (no network hop within Next.js if the dashboard process is co-located); write-side is Server Actions calling the same caller. Network calls only happen between the dashboard process and the MCP server. |
| shadcn/ui component sprawl | low | low | Add components on demand, not preemptively. The `components/ui/` directory grows with the pages, not ahead of them. |
| Auth: dashboard process talking to MCP server's tRPC needs a bearer | resolved | — | Spec resolved: reuse `LIBRARIAN_ADMIN_TOKEN`. Dashboard process reads it from env; passes as `Authorization: Bearer …`. |

### Phase 7 — Retire the old dashboard

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Removing legacy `/api/*` REST breaks something I missed | medium | high | Grep the entire tree (including `integrations/`) for `/api/` references before removal. Issue a deprecation log line for one release before the actual removal. |
| `public/` removal breaks Docker build assumptions | low | low | Update Dockerfile in the same PR; CI builds the image. |

### Phase 8 — Docker Compose

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Container env shadows local env in subtle ways (data paths, ports) | medium | medium | docker-compose target runs `pnpm healthcheck` against itself as part of the PR; healthcheck script already covers the JSONL, rebuild, lifecycle, MCP stdio, HTTP MCP+auth surface. |
| Multi-stage builds bloat or break Next.js standalone output | medium | medium | Use the official Next.js Dockerfile as a starting point; pin Node version to match local development. |
| Compose file references env vars that don't exist in `.env.example` | medium | low | Update `.env.example` in the same PR; CI runs `docker compose config` to validate. |

### Phase 9 — Polish

Mostly docs; no significant risks. Main hazard is starting too late and discovering the docs don't actually match what we built.

## Verification checkpoints

Every phase, before merging the PR that closes it:

```sh
pnpm install --frozen-lockfile
pnpm lint                       # zero errors
pnpm typecheck                  # zero errors
pnpm test                       # all packages green
pnpm healthcheck                # five-check end-to-end smoke
```

Plus phase-specific verifications:

| Phase | Specific checks |
|---|---|
| P1 | Pre-commit hook fires on a known-bad file (intentionally fail prettier; the hook blocks the commit). CI runs the full pipeline on a noop PR and passes. |
| P2 | `the-librarian sessions list` works end-to-end. `npm run smoke` (legacy) still passes. |
| P3 | `pnpm --filter @librarian/core build` produces clean `.d.ts`. Import surface from `mcp-server` and `cli` is byte-identical to before the split. |
| P4 | Co-mounted server: `curl /mcp` works with bearer, `curl /trpc/sessions.list` works with bearer, both return correct content. Old `/api/*` REST routes still respond (deprecated but live). |
| P5 | Every wrapper script under `integrations/<harness>/wrapper.sh` runs its healthcheck cleanly against the new CLI binary. |
| P6 | Feature-parity checklist (filed in the PR) passes: every interactive control on the old dashboard has an equivalent on the new one. Playwright tests pass. |
| P7 | `grep -rn "/api/" packages/ apps/` returns zero hits. Old dashboard URL serves 404 or redirects to the new path. |
| P8 | `docker compose up -d && pnpm healthcheck` against the compose stack passes. `docker compose down -v` cleans up. |
| P9 | A stranger (or a hot-reloaded Claude Code session with no prior context) can read `CONTRIBUTING.md` and answer: "where do I add a new MCP tool?" in under a minute. |

## Approximate PR sizing

Used by Phase 3 of the gated workflow (Tasks) to break each phase into reviewable units. **These are estimates** — the actual breakdown lands in the Tasks artifact.

| Phase | Estimated PRs | Notes |
|---|---|---|
| P1 Foundation | 1–2 | One for pnpm workspaces + TS config + Vitest; one for ESLint/Prettier/Lefthook (or merged into one) |
| P2 Relocation | 1 | Atomic; smaller blast radius if everything moves in one shot |
| P3 Core TS port | 3–5 | One per significant module: schemas, memory store, session store, projection, formatters |
| P4 mcp-server TS + tRPC | 4–6 | One per: HTTP/auth port, tool handlers (could be 1–2 PRs), tRPC router scaffold, tRPC procedures (memories + sessions), pino logging |
| P5 CLI port | 1–2 | TS port + verb split; healthcheck against integration wrappers |
| P6 Dashboard | 4–6 | Scaffold + Tailwind/shadcn, Memories page, Sessions list + detail, lifecycle controls, promote-to-memory form, Playwright pass |
| P7 Retire old dashboard | 1 | Single cleanup PR |
| P8 Docker | 1–2 | Dockerfiles + compose + DEPLOYMENT.md update |
| P9 Polish | 1–2 | CONTRIBUTING.md, ADRs, README pass |
| **Total** | **17–26 PRs** | |

## Sequencing recommendation

Ideal serial order if working alone (one PR in flight at a time):

```
P1 → P2 → P3 → P4 → P5 → P6 → P7 → P8 → P9
```

If multiple PRs can be in flight, the parallelisation opportunities are:

- **After P3 lands:** P4 and P5 can run in parallel on separate branches. P5 is smaller and ships first; P4 takes longer.
- **Within P4:** the tRPC scaffold PR can land before all the procedures are written; procedure PRs can land in any order once the router exists.
- **After P4 ships its tRPC scaffold:** P6 can start scaffolding the Next.js app even before P4 finishes all procedures (use type-stubs for procedures not yet implemented).
- **P8 (Dockerfiles):** the mcp-server Dockerfile can start being drafted during P4. Compose file waits on P6.

For solo work, the serial path is safer. If a second hand joins (or an agent runs in parallel), apply the parallelisation map above.

## Cross-cutting concerns

These don't belong to a single phase; they need ongoing care.

| Concern | Owned by | Approach |
|---|---|---|
| Test count never decreases | Every PR | CI asserts `pnpm test` reports ≥ baseline test count. Baseline updates only when a test is deliberately removed (with a PR note). |
| Type coverage never decreases | P3 onward | CI runs `tsc --noEmit` with `strict: true`. Per-PR diff: no new `any`, no new `@ts-ignore` without a comment. |
| File LOC cap | P3 onward | Soft lint rule warning at 400 LOC; review-blocking discussion at 500. |
| Existing integration wrappers pass | P5 onward | Each integration package's `healthcheck.md` script runs in CI against the new build. |
| Storage compatibility | All phases | The store's `appendEvent` / `appendSessionEvent` JSON shape never changes. CI loads a fixture `events.jsonl` + `sessions.jsonl` from before the migration and asserts the projection rebuild succeeds. |

## Out of scope for this plan

These are deliberate exclusions; revisit only if they become blocking:

- Migration to a different test runner mid-overhaul (Vitest is chosen; not adding Jest as a fallback).
- Schema migrations (storage format is locked per the spec).
- Dependency injection framework (function-factory pattern in the code style is sufficient).
- Internationalisation of the dashboard.
- Authentication beyond bearer tokens (no OAuth, SSO, etc.).
- Performance benchmarking (not a stated success criterion; if needed it goes in a separate spec).

## Approval checklist

Before this plan is locked and Tasks (Phase 3 of the workflow) begin:

- [ ] Dependency graph matches reality (no missed module dependencies)
- [ ] Parallelisation opportunities make sense given who is working on what
- [ ] Risks per phase feel right (no over- or under-stating)
- [ ] Verification checkpoints are practical (commands run cleanly, not aspirational)
- [ ] PR sizing is in the right ballpark (the Tasks artifact will tighten this)
- [ ] Sequencing recommendation matches how we want to actually work

## Next artifact

Once approved, the Tasks artifact (Phase 3 of the workflow) breaks each phase into per-PR units with:

- explicit acceptance criteria
- explicit verification steps (commands to run)
- explicit file lists (what gets touched)
- explicit dependency notes (which task unblocks which)

Tasks live at `specs/maintainability-overhaul-tasks.md` and land in their own PR for review before implementation begins.

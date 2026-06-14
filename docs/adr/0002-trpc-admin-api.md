# ADR 0002 — tRPC for the dashboard admin API

- **Status:** Accepted — tRPC remains the admin API shape; its *network exposure* is amended by [ADR 0008](./0008-auth-secrets-model.md) (2026-06-14): `/trpc` moves to an internal-only listener and the admin token is dropped as a network gate.
- **Date:** 2026-05-20
- **Phase context:** Maintainability overhaul, Phase 4 (T4.3–T4.5) and Phase 6 (T6.2).

## Context

The pre-overhaul Librarian exposed two HTTP surfaces:

- `/mcp` — JSON-RPC, bearer-token authenticated. Agents call it.
- `/api/*` — hand-written REST endpoints in `dashboard.js`, unauthenticated. The legacy dashboard called these.

The REST surface was painful in several specific ways:

- Each endpoint had to be discovered by reading `dashboard.js`; there was no schema.
- Inputs were parsed ad-hoc — no shared validation between client and server.
- The browser client (`public/app.js`) had no static types for any of it.
- Cross-cutting concerns (admin gating, error shape) were repeated in every handler.

When designing the Next.js dashboard, we wanted:

- A single source of truth for procedure signatures (input/output shape).
- Type-safe browser calls without manually maintaining a client.
- Easy admin gating at the procedure level, not per-route.
- A boundary that lets the dashboard fan out reads (browser) and writes (Server Actions) at the same procedures.

## Decision

Adopt **tRPC v11** as the admin API surface, served at `/trpc/*` on the mcp-server. The dashboard imports the `AppRouter` type from `@librarian/mcp-server` and uses two client shapes:

- **Browser reads** — `createTRPCReact<AppRouter>()` wired through a same-origin `/api/trpc/[trpc]` proxy that injects the admin token server-side. Browser callers never see the bearer.
- **Server-side writes** — `createTRPCClient<AppRouter>()` in Server Actions, talking directly to the mcp-server with the admin token attached server-side.

All procedures sit under `adminProcedure`, which checks the bearer once. Inputs are Zod schemas; outputs flow through `superjson` for richer types. Error shape is the standard tRPC error envelope, mapped onto HTTP status codes by the standalone adapter.

The MCP JSON-RPC endpoint stays untouched — it speaks the MCP protocol that the wider ecosystem expects.

## Consequences

**Positive**

- One source of truth (`packages/mcp-server/src/trpc/router.ts`) covers every dashboard procedure. The dashboard imports its types via `pnpm` workspaces with zero codegen.
- Admin gating, error mapping, and superjson serialisation are written once in `adminProcedure`. Per-procedure files stay focused on the store call.
- Browser autocompletion + type errors catch dashboard regressions at compile time. We were burned twice during Phase 6 by misaligned input shapes that tRPC's Zod gate surfaced immediately.
- The browser proxy gives us one place to enforce the `Sec-Fetch-Site: same-origin` rule and strip inbound `authorization` / `cookie` headers.

**Negative**

- Two clients to keep aware of: the React Query browser client and the plain `createTRPCClient` Server Action client. We documented why in `apps/dashboard/lib/trpc-client.ts` / `trpc-server.ts`.
- tRPC v11 release candidates moved fast during Phase 4. We pinned to a tested RC and accepted that future bumps need verification rather than blind upgrades.

## Alternatives considered

- **REST + OpenAPI codegen.** Rejected: the codegen overhead and the structural mismatch between REST verbs and our store's verbs (e.g. `promote_session_fact`) would have left us writing Zod schemas, OpenAPI schemas, *and* hand-rolled clients.
- **GraphQL.** Rejected: the dashboard's query shape is tabular and procedure-style — sessions, memories, events, recall results. We weren't going to benefit from the field-selection mechanic, and a GraphQL server is a much heavier dependency than a tRPC router.
- **Plain JSON over `fetch`, with Zod on both sides.** Rejected: tRPC is essentially this with the wiring written for us. We'd have re-implemented a worse version of the React Query bridge.
- **Direct MCP JSON-RPC calls from the dashboard.** Rejected: the MCP transport is for agents — its output is text content blocks intended for an LLM, not structured rows for a UI. The two consumers want different shapes from the same store.

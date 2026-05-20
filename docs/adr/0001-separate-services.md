# ADR 0001 — Separate `mcp-server` and `dashboard` services

- **Status:** Accepted
- **Date:** 2026-05-20
- **Phase context:** Maintainability overhaul, Phases 6–8.

## Context

The pre-overhaul Librarian was one Node process serving three concerns from the same port (3838):

1. The MCP JSON-RPC endpoint (`/mcp`) for agents.
2. The legacy admin dashboard (static `public/` + `/api/*` JSON endpoints).
3. The healthcheck (`/healthz`).

That worked for a low-traffic personal VPS but pinned several decisions together that should be independent:

- The dashboard had to be plain hand-written HTML/CSS/JS because the runtime didn't include a bundler. Anything richer (typed client, modern UI primitives, server-side data fetching) required adding a build step to the same process.
- The admin REST endpoints under `/api/*` lacked authentication while `/mcp` required a bearer token. Tightening that gap (see `issues/001-dashboard-rest-no-auth.md`) inside a single process meant either auth-gating browser routes (breaks the "open dashboard" assumption) or pushing browser auth state through cookies/sessions (large change for limited benefit).
- Deploys coupled UI iteration to MCP-server availability. A typo in admin HTML restarted the MCP endpoint that agents depend on.
- The MCP server, which serves machine traffic that should be small and stable, was bloated by Next.js-grade dependencies anyone bringing a real admin UI would need.

## Decision

Split into two services:

- **`@librarian/mcp-server`** (Node 22) — JSON-RPC at `/mcp`, typed admin API at `/trpc/*`, liveness at `/healthz`. Port `3838`. Owns the data directory.
- **`@librarian/dashboard`** (Next.js 14 / React) — the admin UI. Reads via browser tRPC through a same-origin `/api/trpc/[trpc]` proxy that injects the admin token server-side; writes via Server Actions that call the mcp-server's tRPC over HTTP. Port `3000`. Stateless.

Both ship as separate Dockerfiles (`docker/mcp-server.Dockerfile`, `docker/dashboard.Dockerfile`) and run together via `docker/docker-compose.yml`. The dashboard reaches the mcp-server through the internal compose network (`LIBRARIAN_SERVER_URL=http://mcp-server:3838`).

## Consequences

**Positive**

- The admin token never reaches the browser. The dashboard proxy + Server Actions are the only callers of `/trpc/*`; the bearer is held by the dashboard server process.
- UI iteration doesn't risk MCP availability. Restarting the dashboard container leaves agents connected to `/mcp`.
- The mcp-server image stays small (no React, no Next.js, no Tailwind). The dashboard image only ships the Next.js standalone bundle.
- The dashboard is a regular Next.js app, so it benefits from the framework's caching, routing, and Server Actions without bolting any of that onto the MCP server.
- The `issues/001-dashboard-rest-no-auth.md` gap closes naturally: the `/api/*` routes are gone (T7.1), and `/trpc/*` is admin-gated.

**Negative**

- Two containers to operate instead of one. We mitigate this by shipping a single `docker compose` file and a `pnpm healthcheck -- --remote` mode that probes a deployed stack.
- Two builds to keep in sync. The dashboard imports `AppRouter` types from `@librarian/mcp-server` at compile time; if the mcp-server's tRPC surface changes incompatibly, the dashboard build will fail before either ships.
- An extra hop for browser reads: browser → dashboard proxy → mcp-server. Acceptable for an admin UI; latency budget is generous.

## Alternatives considered

- **Single Next.js app that also serves `/mcp`.** Rejected: pulls Next.js into the agent-traffic path, mixes the small JSON-RPC server's failure modes with the dashboard's, and complicates the stdio MCP entrypoint, which has nothing to do with HTTP.
- **Embed a richer admin UI inside the existing Node HTTP server.** Rejected: would require introducing a bundler into a service whose job is "answer JSON-RPC over HTTP." The mcp-server's surface is intentionally small.
- **Keep `/api/*` and just add auth.** Rejected: the new typed admin API (tRPC) is a strict improvement over hand-maintained REST + ad-hoc Zod, and once we had tRPC there was nothing keeping the legacy `/api/*` alive.

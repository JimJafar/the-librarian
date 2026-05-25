# Spec: One-command deploy — single-container image

## Status

Drafted 2026-05-24. Four serial PRs (C1–C4). Phase 1 of the "reduce self-hosting friction"
initiative (Deploy → Persistence → Auth). Independent of the other two specs; do this first
because it changes how everything runs (loopback URL, ports) and later verification depends on it.

## Objective

Make standing up The Librarian a **single command**. Today a deployer runs *two* node apps (the
MCP server and the dashboard), which is the friction that makes the marketplace plugins "do
nothing until you set up a server." Ship **one container image** that runs both, a `docker run`
one-liner, and a hosted-platform template — so giving the tool to someone (or running it on a
remote box, which is the primary deployment) is trivial.

**The current state.**

- **MCP server** (`packages/mcp-server`): HTTP bin `src/bin/http.ts` serves `/healthz`, `/mcp`,
  `/trpc/*` on `LIBRARIAN_HOST:LIBRARIAN_PORT` (default `127.0.0.1:3838`). Opens the store at
  `LIBRARIAN_DATA_DIR`. Already handles SIGTERM/SIGINT via `shutdown()` (`bin/http.ts`).
- **Dashboard** (`apps/dashboard`): Next.js 15.1.4 app-router, `output: "standalone"`, port 3000.
  **Stateless** — never opens the store; reaches the MCP server over tRPC at `LIBRARIAN_SERVER_URL`
  (default `http://127.0.0.1:3838`), injecting `LIBRARIAN_ADMIN_TOKEN` server-side.
- **Existing deploy assets**: `docker/mcp-server.Dockerfile`, `docker/dashboard.Dockerfile`,
  `docker/docker-compose.yml` (two services), `DEPLOYMENT.md`, `.env.example`.
- **Latent bug**: `docker/dashboard.Dockerfile` healthcheck hits `/health` — an SSR page that
  returns 200 even when the MCP server is down (weak liveness probe).

**Success means:** `docker run … ghcr.io/<owner>/the-librarian` (one image, one command) brings up
a working Librarian — dashboard on 3000, MCP on 3838, data on a `/data` volume — and a `fly.toml`
gives a one-command hosted deploy. The existing two-container compose remains for advanced users.

## Non-goals

- **Not collapsing the two apps into one process** beyond a supervisor. An in-process embed (Next
  custom server importing the MCP HTTP handler) fights Next's `output: "standalone"` pruning and
  couples the build graphs — rejected. Two child processes under one supervisor is the bar.
- **Not changing app behaviour, auth, or the store.** Pure packaging/run-shape work. (Auth and
  persistence are the other two specs.)
- **Not removing the two-container compose.** It stays under "Advanced" in `DEPLOYMENT.md`.
- **Not multi-arch/Kubernetes/Helm.** A single linux/amd64 (and optionally arm64) image + a Fly
  template is the scope; orchestration is out.

## Decisions (resolved)

- **Supervisor entrypoint, two processes, one image.** A ~40-line zero-dep Node script is PID 1,
  spawns both servers, forwards signals, and crash-fasts if either dies. Rejected alternatives:
  in-process embed (above); shell `&` (poor signal handling + zombie reaping).
- **Dashboard → MCP over loopback inside the container.** `LIBRARIAN_SERVER_URL=http://127.0.0.1:3838`
  baked into the image; MCP binds `127.0.0.1`. No app code changes — just env.
- **Publish both ports (3000 + 3838).** Agents POST directly to `/mcp` with a bearer token, so the
  MCP port is exposed. (A single-public-port design — proxying `/mcp` through the dashboard — is
  deferred; note it as a future option if a one-port deploy is wanted.)
- **Hosted template = Fly.io.** Best fit for a single container + a persistent volume at `/data` +
  private networking, single-machine pricing. Railway/Render are fine alternatives; the `docker run`
  one-liner is host-agnostic.
- **`LIBRARIAN_SECRET_KEY` becomes recommended** in the deploy docs (it encrypts the curator LLM
  token today and S3 creds in the Persistence spec). Document `openssl rand -hex 32`.

## Tech stack

No new runtime dependencies. `docker/supervisor.mjs` uses only `node:child_process`. Build reuses
the existing two Dockerfiles' multi-stage structure (`pnpm install --frozen-lockfile`, `USER node`,
`chown /data`, `EXPOSE`, `HEALTHCHECK`).

## Plan (PRs)

### C1 — Supervisor entrypoint

A tested process supervisor that boots both servers in one process tree.

- **Create** `docker/supervisor.mjs` (zero-dep): `spawn` `node <mcp>/dist/bin/http.js` and
  `node apps/dashboard/server.js` with `stdio: "inherit"`; relay SIGTERM/SIGINT to both children;
  on a child exiting while not shutting down, kill the sibling and `process.exit(1)` (crash-fast so
  the container restarts the whole pair).
- **Create** `docker/supervisor.test.mjs` (Vitest, new glob or `packages/mcp-server/tests`): drive
  the supervisor against two trivial fake child scripts.
- **Reuse**: the existing `shutdown()` shape in `bin/http.ts` — each child already cleans up on
  signal, so the supervisor only forwards.
- **Tests (RED first)**: (a) both children start; (b) SIGTERM to the supervisor terminates both and
  exits 0; (c) child A exits 1 → supervisor kills B and exits non-zero.
- **Acceptance**: supervisor starts/stops both cleanly; crash-fast verified; no zombies.

### C2 — Combined Dockerfile

- **Create** `docker/all-in-one.Dockerfile` (merge the two existing Dockerfiles as the template):
  builder stage installs the workspace, builds `@librarian/core` + `@librarian/mcp-server` +
  `@librarian/dashboard`; runtime stage copies the mcp-server `dist` + pruned `node_modules`, the
  Next standalone tree, and `supervisor.mjs`.
- **In-image env defaults**: `LIBRARIAN_DATA_DIR=/data`, `LIBRARIAN_HOST=127.0.0.1`,
  `LIBRARIAN_PORT=3838`, `LIBRARIAN_SERVER_URL=http://127.0.0.1:3838`, `PORT=3000`,
  `HOSTNAME=0.0.0.0`, `NODE_ENV=production`.
- `EXPOSE 3000 3838`; `HEALTHCHECK` probes `127.0.0.1:3000/api/health` (from C3) **and**
  `127.0.0.1:3838/healthz`; `CMD ["node", "supervisor.mjs"]`; `USER node`; `chown` `/data`.
- **Tests**: a `docker build -f docker/all-in-one.Dockerfile` smoke job; optionally a scripted
  `docker run` + curl of both health endpoints. If CI can't run Docker, gate behind a manual
  workflow and document the local commands.
- **Acceptance**: image builds; `docker run` brings up both servers; both health endpoints 200.

### C3 — Real dashboard liveness route + healthcheck fix

- **Create** `apps/dashboard/app/api/health/route.ts` — a Route Handler returning `{status:"ok"}`
  200 **without** calling the MCP server (pure liveness). The existing `/health` SSR page stays as
  the readiness view that exercises tRPC.
- **Modify** `docker/dashboard.Dockerfile` healthcheck `/health` → `/api/health` (fixes the weak
  probe).
- **Reuse**: the Route Handler pattern in `app/api/trpc/[trpc]/route.ts`.
- **Tests**: Vitest handler test (200 + JSON), mirroring `tests/health-page.test.tsx`.
- **Acceptance**: `/api/health` returns 200 regardless of MCP state; healthcheck uses it.

### C4 — One-liner + hosted template + docs

- **Create** `fly.toml` (root): one machine, a `[mounts]` volume `librarian_data` → `/data`,
  `[http_service] internal_port = 3000`, an optional service for 3838; document
  `fly secrets set LIBRARIAN_ADMIN_TOKEN=… LIBRARIAN_AGENT_TOKEN=… LIBRARIAN_SECRET_KEY=…`.
- **Create/extend** deploy docs with the one-liner:
  `docker run -d -p 3000:3000 -p 3838:3838 -v librarian_data:/data -e LIBRARIAN_ADMIN_TOKEN=… -e LIBRARIAN_AGENT_TOKEN=… -e LIBRARIAN_SECRET_KEY=$(openssl rand -hex 32) ghcr.io/<owner>/the-librarian:latest`
- **Modify** `DEPLOYMENT.md`: add "Single container (recommended)" above the compose; move the
  two-container compose under "Advanced". Update `.env.example` (note `LIBRARIAN_SERVER_URL` is set
  in-image for the combined image).
- **Optional** `.github/workflows/image.yml`: build + push the image to `ghcr.io` on tag/release.
- **Acceptance**: a fresh machine runs the one-liner and reaches a working dashboard + MCP; the Fly
  template deploys with secrets set.

## Verification (end-to-end)

```
docker build -f docker/all-in-one.Dockerfile -t librarian:test .
docker run -d -p 3000:3000 -p 3838:3838 -v lib_test:/data \
  -e LIBRARIAN_ADMIN_TOKEN=a -e LIBRARIAN_AGENT_TOKEN=b \
  -e LIBRARIAN_SECRET_KEY=$(openssl rand -hex 32) librarian:test
curl -s localhost:3000/api/health        # {"status":"ok"}
curl -s localhost:3838/healthz           # mcp_auth: enabled
curl -s -X POST localhost:3838/mcp -H "Authorization: Bearer b" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'   # tool list
# open localhost:3000 → dashboard renders + lists memories (proves loopback)
docker stop <id>                          # returns promptly (SIGTERM forwarding)
```

`pnpm -w test` and `pnpm -w typecheck` green; supervisor unit test green.

## Risks / open items

- **Shared fate**: one image means an MCP crash and a dashboard crash both restart the container.
  Acceptable for single-owner; note it.
- **Single public port**: if a one-port deploy is later wanted, add a `/mcp` pass-through Route
  Handler in the dashboard (like the tRPC proxy). Deferred.
- **CI Docker**: if the CI runner can't build/run Docker, the C2 smoke job becomes a manual/optional
  workflow; the unit tests (C1, C3) still gate.

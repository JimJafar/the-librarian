# Spec: configurable dashboard published port (default 3042)

**Status:** in progress · **Date:** 2026-06-30

## Problem

`librarian server up` publishes the dashboard on host port **3000**
(`buildRunArgs` → `-p ${host}:3000:3000`). 3000 is one of the most
collision-prone ports on a dev box (every other Node/Next app grabs it), so a
self-host on a busy machine fails to bind or silently shadows another app.

There is also no way to choose a different dashboard port and have it **survive
`server update` / autoupdate** — `update` strictly recreates the container from
`deploy-state.json`, and the port isn't recorded there.

## Decision

1. **Default published port → 3042.** Only the *host-published* side moves. The
   container still listens internally on 3000 (image `PORT=3000`, internal
   healthcheck `127.0.0.1:3000`), so the mapping becomes
   `-p ${host}:${dashboardPort}:3000`. No Dockerfile / healthcheck change.

2. **Override via `--dashboard-port`, persisted in `deploy-state.json`.** This is
   the same carrier `host` / `dataVolume` / `dataDir` / `ref` already use:
   `up` records it, `update` reads it back and reuses it, and `autoupdate --run`
   (which calls `runUpdate`) inherits it for free. *Not* an env var — an env var
   would have to be present in the systemd-timer / cron environment on every
   autoupdate fire, and `LIBRARIAN_DASHBOARD_PORT` is already taken by the MCP
   server (`mcp-server/src/bin/http.ts`).

3. **Existing deployments keep 3000.** A `deploy-state.json` written before this
   field has no `dashboardPort`. On the next `update` / autoupdate it is treated
   as **3000** (its historical value) and **backfilled** into the state — so a
   running server never silently jumps ports under the operator. Only a fresh
   `server up` defaults to 3042.

## Surface

- `librarian server up [--dashboard-port <1-65535>]` — default `3042`.
- Validation (teaching errors): integer in `1..65535`; reject `3838` (the
  MCP published port — would collide on the same host).
- To change the port on an existing deploy: re-run `server up --dashboard-port N`
  (same way you'd change `--host` today). `update` does not take the flag.

## Touch points

- `server/deploy-state.ts` — optional `dashboardPort?: number` (back-compatible,
  like `dataDir`).
- `server/up.ts` — `DEFAULT_DASHBOARD_PORT = 3042`, `LEGACY_DASHBOARD_PORT = 3000`,
  `resolveDashboardPort()`, thread through `buildRunArgs` + the dashboard URL +
  `writeDeployState`.
- `server/update.ts` — `state.dashboardPort ?? LEGACY_DASHBOARD_PORT`; carry it
  into `buildRunArgs` + `writeDeployState` (backfill).
- `runtime.ts` — parse `--dashboard-port`.
- Docs that state the *published* dashboard URL → 3042 (first-run, install,
  dashboard, self-host, manual-install). The *internal* service port (ADR 0001,
  Dockerfile) stays 3000.

## Out of scope

- `docker-compose.yml` (already publishes `3839:3000`, a distinct manual path —
  not collision-prone, and changing it would move existing compose users).

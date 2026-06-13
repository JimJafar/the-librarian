# Feature doc: `librarian server` — self-host the Librarian from the CLI

**Status:** feature doc (pre-spec), 2026-06-13. To be turned into a spec next session. Companion to the harness installer (`docs/specs/2026-06-13-installer-cli.md`, Phase 1 in review as PR #364).

## The idea

Today `@the-librarian/cli` (`librarian`) installs the Librarian into agent harnesses on a *client* machine. It does **not** set up the Librarian *server*. This doc proposes adding server self-hosting so one tool can stand up the whole thing: run the server on a host, then point clients at it.

## Why it's worth doing

Standing up the server is the biggest hurdle for a new adopter — far bigger than the harness configs the CLI already smooths. The server today means: clone the monorepo, write a `.env`, `docker compose up`, wire Tailscale/TLS, and manage the master key + agent tokens. A `librarian server up` that wraps that happy path **closes the loop** and makes the Librarian a self-contained product: server on the host → token → clients.

## What it would look like

A `server` command group:

- `librarian server up` — stand up / configure the server on this host
- `librarian server update` — pull + rebuild + restart
- `librarian server down` — stop
- `librarian server logs` / `status` — observe

**`server up` flow:**
1. Check prerequisites: Docker + Compose, git.
2. Clone or update the monorepo into a deploy dir (`~/.librarian/server`, or a chosen path).
3. Prompt for + write the deploy **`.env`** (ports, optional OAuth / backup remote). **Generate** the master secret key — never ask the user to supply one.
4. `docker compose -f docker/docker-compose.yml up -d --build`.
5. Optionally install a systemd unit so it survives reboot (the existing guybrush setup).
6. **Print the MCP URL + a freshly-minted agent token** — paste straight into `librarian install` on clients. This is the loop-closer.

### Two corrections to the naive sketch
- **Server config ≠ shell rc.** The harness installer writes the *client's* env (`LIBRARIAN_MCP_URL` / token) to `~/.librarian/env` + the shell rc. The *server's* config is the deploy-dir **`.env`** that `docker compose` reads. Different file, different machine, different purpose — don't conflate them.
- **"Start the server" = Docker Compose**, not a bare `node`/`pnpm start`. The repo already deploys via `docker/docker-compose.yml` + a systemd unit. `server up` must wrap that existing mechanism, not invent a second deployment path.

## Open architecture decision: one CLI or two?

The harness commands (`librarian install …`, client machines) and server management (`librarian server …`, host) serve different audiences on different machines. Two shapes:

**A — one CLI, two command groups (recommended).** `@the-librarian/cli` / `librarian` keeps `install`/`status`/… for harnesses and *gains* a `server` group.
- **+** One install, one tool to learn; `librarian --help` reveals both; the token handoff feels native.
- **+** Shares config / env / http / machine-id / exec infra — no duplication.
- **+** Server code is tiny and only runs when invoked → no burden on client-only users (no Docker dep at install time, only at `server up`).
- **+** Zero churn to the in-flight `@the-librarian/cli` — the `server` group is purely additive.
- **−** Ships a few KB of deploy code to laptops that won't run it (negligible).

**B — two CLIs.** A client tool + a separate server tool (e.g. `@the-librarian/server`, bin `librarian-server`).
- **+** Hard audience separation; the server tool can grow heavy (absorb all admin) and version/distribute independently.
- **−** Duplicated shared infra (or a third shared lib); two installs; the loop-closer spans two tools.

**On naming** (the `client-cli` / `server-cli` idea): even under option B, do **not** rename the client to `client-cli`. The harness tool is the common case nearly everyone runs — it deserves the clean name `librarian`. The server tool is the specialist → `librarian-server` / `@the-librarian/server`. Asymmetric naming that favors the common case beats symmetric naming that taxes it. Under option A no renaming arises at all (just `librarian server`). **Either option leaves the in-flight `@the-librarian/cli` untouched**, so this decision does not block PR #364.

## Scope (for the spec)
- Cover the easy self-host path: **Docker Compose on a Linux/macOS host**. Advanced deploys (k8s, fly.io, bare-metal, Windows) → defer to `DEPLOYMENT.md`.
- Convergence opportunity: the existing private `@librarian/cli` server-admin commands (`migrate-data-dir`, `backup`, `rebuild`, `seed`) are the *same* audience (the host). They could live under `librarian server admin …`, unifying the whole server-side surface under one tool.

## Open questions for the spec session
1. **One CLI (A) or two (B)?** (Lean: A.)
2. Deploy dir default + handling an existing / other clone (reuse vs fresh).
3. `.env` schema: which values prompt, which generate, which default. Master-key generation + storage. OAuth/backup optional.
4. Boot persistence: opt-in `systemd` prompt during `up`, or a separate `librarian server enable-boot`? macOS (`launchd`) parity?
5. Token handoff: print only, or also auto-write the local client's `~/.librarian/env` when `up`-ing on a machine that's *also* a client?
6. Does `server` absorb the existing admin CLI commands now, or stay deploy-only for v1?
7. Upgrades: `server update` = git pull + rebuild; how to surface "a newer release exists" (ties into the Phase-2 version comparison the dashboard already does).
8. Multi-host: does one operator running several server hosts ever make sense, or is the server strictly single-instance? (Affects whether `server status` needs the machine-id treatment.)

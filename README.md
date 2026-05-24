# The Librarian

[![CI](https://github.com/JimJafar/the-librarian/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/JimJafar/the-librarian/actions/workflows/ci.yml)

The Librarian is a portable **memory + session layer for AI agents**. It gives agents one
disciplined funnel for recalling, proposing, saving, updating, and reviewing durable context, plus
a neutral **cross-harness session-continuity layer** so work started in one harness (Claude Code,
Codex, Hermes, OpenCode, Pi) can be handed off and resumed cleanly in another.

It runs as a small self-hosted server you can reach **locally or remotely**:

- **Durable memory** — `recall` / `remember` / `verify` with categories, scoping
  (`common` vs `agent_private`), a proposal flow for protected categories, and a three-state
  (`active` / `proposed` / `archived`) model.
- **Cross-harness sessions** — start / checkpoint / pause / end / continue, with a handover package
  any harness can resume. Session history is *evidence*; durable facts are promoted explicitly.
- **Memory curator** — an optional scheduled LLM pass that grooms memory (dedupe, archive stale,
  refine), configured and observed from the dashboard.
- **Dashboard** — a Next.js admin cockpit (Memories, Sessions, Recall, Proposals, Archive, Logs,
  Analytics, and the Curator cockpit) with a persistent nav + ⌘K command palette.
- **Harness integrations** — copyable setup packages under [`integrations/`](./integrations/) plus
  two standalone, distributable plugins (see [Harness integrations](#harness-integrations)).

Event-sourced and dependency-light: append-only JSONL ledgers + a generated SQLite/FTS5 index, on
the built-in `node:sqlite` — no external database to run.

## Architecture

A pnpm (Node 22) monorepo. Two long-running services, three libraries, and the integrations:

| Package | Role |
|---|---|
| `@librarian/core` (`packages/core`) | The store: event-sourced memory + sessions over `node:sqlite` + JSONL, schemas, the curator pipeline, the secret/settings store. |
| `@librarian/mcp-server` (`packages/mcp-server`) | Node service exposing `/mcp` (MCP JSON-RPC), `/trpc/*` (typed admin API), `/healthz`; runs the curator scheduler. Also ships an MCP **stdio** server. Default port `3838`. |
| `@librarian/cli` (`packages/cli`) | The `the-librarian` binary — the full session lifecycle + `rebuild`/`seed` from any shell, against a local store. |
| `@librarian/dashboard` (`apps/dashboard`) | **Next.js 15** admin cockpit. Default port `3000`. |
| `integrations/` | Per-harness setup + the shared lifecycle helper (`@librarian/lifecycle`). |

The dashboard is **stateless** — it never opens the store. It reaches the mcp-server over tRPC
(browser calls go through a same-origin `/api/trpc/[trpc]` proxy that injects the admin token
server-side; the token never reaches the browser). Agents talk to `/mcp` with a bearer token.

**Local or remote.** Agents and the harness lifecycle hooks can drive a Librarian on the same
machine *or* a remote one: set `LIBRARIAN_MCP_URL` (+ a token) and the lifecycle talks to the
remote `/mcp` over HTTP; unset, it uses the local `the-librarian` CLI against `LIBRARIAN_DATA_DIR`.

## Quick start

Requirements: **Node 22.5+** (for the built-in `node:sqlite`) and **pnpm 9.15.x** via Corepack:

```sh
corepack enable && corepack prepare pnpm@9.15.0 --activate
```

Local dev (two services):

```sh
pnpm install
pnpm run seed                               # seed sample memories
pnpm run serve                              # mcp-server at http://127.0.0.1:3838
pnpm --filter @librarian/dashboard dev      # dashboard at http://127.0.0.1:3000
```

The MCP HTTP endpoint is `http://127.0.0.1:3838/mcp`; the MCP stdio server runs via `pnpm start`.

```sh
pnpm run healthcheck                              # local end-to-end smoke
pnpm run healthcheck -- --remote http://host:3838 # probe a deployed instance
pnpm test                                         # full Vitest suite
```

### Docker (recommended for a VPS)

```sh
cp .env.example .env                                          # set tokens + secret key
docker compose --env-file .env -f docker/docker-compose.yml up -d --build
```

See [DEPLOYMENT.md](./DEPLOYMENT.md) for the full setup. A **single-container** image and a
one-command hosted deploy are in progress — see [Roadmap](#roadmap).

## Configuration & secrets

The Librarian uses **two different kinds of secret**, which is the most common point of confusion:

| Env var | Kind | What it's for |
|---|---|---|
| `LIBRARIAN_ADMIN_TOKEN` | **access token** (bearer) | Authenticates the *admin* caller — the dashboard, admin-only MCP tools, and the whole `/trpc/*` admin API. |
| `LIBRARIAN_AGENT_TOKEN` | **access token** (bearer) | A shared token for agents calling `/mcp`. |
| `LIBRARIAN_AGENT_TOKENS` | **access tokens** (bearer) | Comma-separated `agent_id:token` pairs — pins each agent to its identity for attribution + `agent_private` isolation. |
| `LIBRARIAN_SECRET_KEY` | **encryption key** (AES-256) | Encrypts *secret settings at rest* in the DB (today: the curator's LLM API token). **Not** a bearer token — it's never sent over the wire. |
| `LIBRARIAN_DATA_DIR` | path | Where the store lives (default `./data`). |
| `LIBRARIAN_HOST` / `LIBRARIAN_PORT` | network | mcp-server bind address (default `127.0.0.1:3838`). |

Key points:

- **Access token vs encryption key.** `*_TOKEN`/`*_TOKENS` answer *"who is allowed to call the
  API."* `LIBRARIAN_SECRET_KEY` answers *"encrypt this sensitive stored value."* They are not
  interchangeable.
- **`LIBRARIAN_SECRET_KEY` must be a 32-byte CSPRNG value** — a 64-char hex string
  (`openssl rand -hex 32`) or base64 32 bytes. It is **optional**: without it the server runs fine,
  but saving any *secret* setting (e.g. the curator's LLM token in the dashboard) fails with
  *"a master key is required for secret settings."* Once set it **must stay stable** — changing it
  makes previously-encrypted settings unreadable. Losing it loses only encrypted *settings*
  (re-enterable), never your memories/sessions (those are plaintext JSONL/SQLite).
- **No-auth mode is localhost-only.** With no admin token set, the server allows unauthenticated
  access on the loopback interface only; a remote endpoint **must** carry a token over HTTPS.

> **Where this is heading.** The token model is being simplified
> ([`docs/specs/single-owner-auth.md`](./docs/specs/single-owner-auth.md)): the dashboard gets
> owner login (GitHub/Google) so it's no longer VPN-gated, and **agent tokens become
> dashboard-managed** (generate/revoke in the UI) instead of hand-edited env vars. `SECRET_KEY`
> stays — it's encryption, not access.

## Data layout

Default `./data` (override with `LIBRARIAN_DATA_DIR`):

| File | Stores | Authoritative? |
|---|---|---|
| `events.jsonl` | memory event ledger (append-only) | **yes** — memories are JSONL-canonical |
| `session_events.jsonl` | session timeline events (append-only) | yes — the timeline view |
| `librarian.sqlite` | session current state + transition audit + the memory projection + FTS | **yes for sessions** (post-R3); rebuildable for memories |
| `memories.md` | human-readable memory snapshot | no — regenerated |

The memory side is rebuildable from `events.jsonl` via `pnpm run rebuild`; **session state is
SQLite-canonical** and must be backed up. See [Backup](#backup-strategy). Memory writes and session
writes use separate projection paths, so traffic on one never regresses the other.

## MCP tools

### Memory tools

Memories are `active`, `proposed`, or `archived` (the *reason* for archival lives in the event
ledger, not a separate status).

- `start_context` — the required context package for an agent
- `recall` — search memories (`active` only by default)
- `remember` — create an active memory, or a proposal for protected categories. Returns
  `duplicates` as an informational signal; never refuses the write.
- `propose_memory` — create a proposed memory
- `update_memory` — edit an active memory
- `verify_memory` — record a verdict: `useful` / `not_useful` move recall rank by ±1 (clamped ±3);
  `outdated` archives the memory
- `list_proposals` — list pending proposals
- `archive_memory` *(admin)* — archive a memory (agents retire their own via `verify_memory result=outdated`)
- `approve_proposal` *(admin)* — activate, edit, or reject a proposal

### Session tools

- `start_session` — start a session attributed to the calling agent
- `get_session` / `list_sessions` / `list_session_events` / `search_sessions` — reads
- `record_session_event` — append a typed evidence event; implicitly resumes a paused/ended session
- `checkpoint_session` / `pause_session` / `end_session` — explicit lifecycle (`end`'s summary is optional)
- `attach_session` / `continue_session` — cross-harness attach + handover (continue defaults to attach; works on ended sessions)
- `promote_session_fact` — promote a session fact to a durable memory (protected categories route through proposals)

Sessions are `active`, `paused`, or `ended`. Resuming an `ended` session flips it back to `paused`;
the next recorded event flips it to `active`. Restoring is just `continue_session` — no separate
restore verb. Visibility is enforced at the MCP dispatch layer: each agent sees `common` sessions
plus its own `agent_private`; admin bypasses. Full spec (implemented):
[`docs/specs/done/session-layer-and-harness-packages.md`](./docs/specs/done/session-layer-and-harness-packages.md).

### Authentication

- `/mcp` — bearer agent or admin token; admin-only tools require the admin token.
- `/trpc/*` — admin token only (the dashboard injects it server-side; never in the browser).
- `/healthz` — unauthenticated.

## Memory curator

The curator is an **optional, scheduled LLM pass** that grooms the memory store — deduping,
archiving stale entries, and refining wording — turning a growing pile of `remember` calls into a
maintained corpus. It is configured and observed entirely from the dashboard **Curator** cockpit
(`/curator`): provider/endpoint/model + addendum, a schedule, run history with per-action counts,
and a **Run now** button.

The curator's LLM API token is a *secret setting*, encrypted at rest with `LIBRARIAN_SECRET_KEY` —
so you must set that key before saving curator config. The scheduler runs in the mcp-server
(interval via `LIBRARIAN_CURATOR_TICK_MS`). Spec:
[`docs/specs/done/memory-curator-spec.md`](./docs/specs/done/memory-curator-spec.md).

## Dashboard

The Next.js 15 cockpit (`apps/dashboard`, port `3000`) surfaces **Memories** (bulk re-home,
data-driven filters), **Sessions** (lifecycle inspector), **Recall** (two-pane timeline +
insights), **Proposals**, **Archive**, **Logs**, **Analytics**, and the **Curator** cockpit —
reachable from a persistent top nav and a ⌘K command palette (`?` shows shortcuts). Reads go through
the same-origin tRPC proxy; writes use Server Actions. Today the dashboard relies on network gating
(e.g. a VPN/Tailnet); owner login is in progress (see [Roadmap](#roadmap)).

## CLI

The `the-librarian` binary runs the full session lifecycle against a local store, alongside
`rebuild` and `seed`:

```sh
the-librarian sessions start --title "Refactor auth" --harness codex --cwd "$PWD"
the-librarian sessions list --project the-librarian   # --include-ended to surface ended
the-librarian sessions continue ses_… --format markdown
the-librarian sessions checkpoint ses_… --summary-file checkpoint.md
the-librarian sessions pause ses_…
the-librarian sessions end ses_…                       # bare end = "I'm done with this session"
the-librarian sessions search "BM25 recall" --project the-librarian
```

Every verb supports `--json`, `--agent <id>`, and `--admin`. `continue` supports
`--format prose|markdown|claude|codex|opencode|hermes|pi` and `--no-attach`.

## Slash commands

The canonical cross-harness surface is `/lib:session <verb>`; the contract is in
[`docs/slash-commands.md`](./docs/slash-commands.md). Each harness implements it natively — Claude
Code and OpenCode ship per-verb commands (`/lib-session-start`, `/lib-session-resume`, …) plus
`/lib-toggle-private`; Hermes registers a single `/lib:session` and parses the remainder.

## Harness integrations

Copyable setup packages live under [`integrations/`](./integrations/) (Hermes, Claude Code, Codex,
OpenCode, Pi) over a **shared lifecycle helper** (`@librarian/lifecycle`, in
`integrations/shared/`) that provides privacy detection, local state, idempotent session
automation, and both **local-CLI and remote-HTTP** transports.

Two of these are also packaged as **standalone, distributable plugins** in their own repos:

- **Claude Code** — [`the-librarian-claude-plugin`](https://github.com/JimJafar/the-librarian-claude-plugin):
  a marketplace-installable plugin bundling the lifecycle hooks, the `/lib-session-*` commands, the
  `.mcp.json`, and the `use-the-librarian` skill. Configured with `LIBRARIAN_MCP_URL` +
  `LIBRARIAN_AGENT_TOKEN`.
- **Hermes** — [`the-librarian-hermes-plugin`](https://github.com/JimJafar/the-librarian-hermes-plugin):
  a PyPI Memory Provider plugin backed by a remote Librarian over HTTP.

Each in-repo package ships an MCP config example, install steps, the slash-command mapping, a
wrapper script that brackets the harness with `sessions start`/`pause`, and an end-to-end healthcheck.

## Protected memory & agent policy

The `identity` and `relationship` categories are **proposal-only** — agents propose, a human
approves (via the dashboard or `update_memory`); `promote_session_fact` into these categories routes
through the proposal flow regardless of role. Agents should: call `start_context` at the start of
meaningful work; recall before non-trivial tasks; `remember` durable lessons; use proposals for
identity/relationship/major-preference changes; `verify_memory` on hits; bound work with
`/lib:session`; and never auto-promote session content.

## Agent skill

A reusable skill lives at [`skills/use-the-librarian/SKILL.md`](./skills/use-the-librarian/SKILL.md)
— copy it into any skill-aware agent. For agents that don't auto-discover skills, [SOUL.md](./SOUL.md)
points to it. (The Claude Code plugin ships this skill directly.)

## Commands

```sh
pnpm start                                # MCP stdio server
pnpm run serve                            # mcp-server (HTTP) at :3838
pnpm --filter @librarian/dashboard dev    # dashboard at :3000
pnpm run seed                             # seed sample memories
pnpm run rebuild                          # replay JSONL ledgers into the SQLite projection
pnpm run healthcheck                      # end-to-end smoke
pnpm test                                 # full Vitest suite
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the workspace layout and "where to add what" recipes
(new MCP tool / tRPC procedure / dashboard page / CLI verb).

## Roadmap

Active specs in [`docs/specs/`](./docs/specs/) — the "reduce self-hosting friction" line of work:

- **[`deploy-single-container.md`](./docs/specs/deploy-single-container.md)** — one image running
  both services + a one-command hosted deploy.
- **[`persistence-backup-restore.md`](./docs/specs/persistence-backup-restore.md)** — built-in
  backup / restore / export + optional cloud sync.
- **[`single-owner-auth.md`](./docs/specs/single-owner-auth.md)** — dashboard login + dashboard-managed
  agent tokens.

Shorter-horizon items are in [TODO.md](./TODO.md); completed specs are archived in
[`docs/specs/done/`](./docs/specs/done/).

## Backup strategy

Three files under `data/` are load-bearing post-R3 — **back up all three**: `events.jsonl` (memory
canonical), `session_events.jsonl` (timeline), and `librarian.sqlite` (**session-canonical** state +
audit + memory projection + FTS). `memories.md` and `sessions.legacy.jsonl` are regenerable/disposable.

> Pre-R3, `librarian.sqlite` was fully rebuildable from JSONL. **No longer:** session state
> (`status`, `rolling_summary`, `paused_at`/`ended_at`, transition history) lives only in SQLite.

```sh
docker compose -f docker/docker-compose.yml stop mcp-server          # crash-consistent snapshot
rsync -a data/events.jsonl data/session_events.jsonl data/librarian.sqlite \
  /var/backups/librarian/$(date +%Y%m%d-%H%M%S)/
docker compose -f docker/docker-compose.yml start mcp-server
```

Restore: stop the server, copy the three files back, optionally `pnpm run rebuild` (repopulates
`memories.md` + the memory projection), restart. Back up **daily** under active use and **before**
risky operations (migrations, `purge_session`). `librarian.sqlite` is a SQLite DB — copy it stopped,
or use SQLite's online-backup API for live snapshots; the JSONL ledgers are append-only and safe to
`rsync` at any time. Built-in `the-librarian backup` / `restore` / `export`, scheduled backups
(`LIBRARIAN_BACKUP_INTERVAL_MS`), and optional S3-compatible cloud sync are available — see
[DEPLOYMENT.md](./DEPLOYMENT.md#backups).

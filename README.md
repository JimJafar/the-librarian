# The Librarian

[![CI](https://github.com/JimJafar/the-librarian/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/JimJafar/the-librarian/actions/workflows/ci.yml)

The Librarian is a portable memory system for AI agents with a cross-harness session layer for handing work between them. It gives agents one disciplined funnel for recalling, proposing, saving, updating, and reviewing durable context, plus a neutral session-continuity layer so work started in one harness (Hermes, Claude Code, Codex, OpenCode, Pi) can be resumed cleanly in another.

This MVP is intentionally local-first and dependency-light:

- canonical append-only JSONL event logs (`events.jsonl` for memories, `sessions.jsonl` for sessions)
- generated human-readable memory snapshot (`memories.md`)
- generated SQLite + FTS5 query index covering both memories and sessions
- MCP-compatible stdio server and JSON-RPC-over-HTTP endpoint plus a typed tRPC admin API
- Next.js dashboard (`apps/dashboard`) with Memories and Sessions surfaces, Server Actions for writes, and browser tRPC via a same-origin proxy
- `the-librarian` CLI exposing the full session lifecycle from any shell
- harness setup packages under [`integrations/`](./integrations/) for Hermes, Claude Code, Codex, OpenCode, and Pi

## Architecture

Two services:

- **`@librarian/mcp-server`** — Node 22 process exposing `/mcp` (JSON-RPC), `/trpc/*` (admin API), and `/healthz`. Default port `3838`.
- **`@librarian/dashboard`** — Next.js 14 app at `apps/dashboard`. Reads via browser tRPC through a same-origin `/api/trpc/[trpc]` proxy that injects the admin token server-side; writes via Server Actions that hit the mcp-server's tRPC over HTTP. Default port `3000`.

The admin token never reaches the browser. The dashboard is the only consumer of the tRPC admin API; agents continue to talk to `/mcp` with a bearer token.

## Quick Start

Requirements: **Node 22.5+** (for the built-in `node:sqlite`) and **pnpm 9.15.x** via Corepack:

```sh
corepack enable && corepack prepare pnpm@9.15.0 --activate
```

Local dev (two services):

```sh
pnpm install
pnpm run seed
pnpm run serve                              # mcp-server at http://127.0.0.1:3838
pnpm --filter @librarian/dashboard dev      # dashboard at http://127.0.0.1:3000
```

The MCP-compatible JSON-RPC-over-HTTP endpoint is at `http://127.0.0.1:3838/mcp`. The MCP stdio server runs via `pnpm start`.

Production-style local boot with auth tokens:

```sh
LIBRARIAN_ADMIN_TOKEN=dev-admin-token \
LIBRARIAN_AGENT_TOKEN=dev-agent-token \
pnpm run serve
```

Verify end-to-end:

```sh
pnpm run healthcheck                                          # 5/5 local checks
pnpm run healthcheck -- --remote http://host:3838             # against a deployed instance
```

### Docker (recommended for VPS)

```sh
cp .env.example .env                                          # set tokens
docker compose -f docker/docker-compose.yml up -d --build
```

See [DEPLOYMENT.md](./DEPLOYMENT.md) for the full Tailnet-friendly setup, env vars, backups, and recovery procedures.

### Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for workspace layout, "where to add what" recipes (new MCP tool / tRPC procedure / dashboard page / CLI verb), test layering, and the PR conventions.

## Data Layout

By default, data is stored in `./data`.

Override with:

```sh
LIBRARIAN_DATA_DIR=/path/to/librarian-data pnpm start
```

Files:

- `events.jsonl` — canonical append-only event log for memories
- `sessions.jsonl` — canonical append-only event log for sessions
- `librarian.sqlite` — generated SQLite index (memories + sessions + FTS)
- `memories.md` — generated human-readable snapshot of memories

The JSONL logs are the source of truth. SQLite and Markdown can be rebuilt at any time via `pnpm run rebuild`. Memory writes never touch the session projection and vice versa — each ledger has its own incremental projection path so traffic on one side does not regress the other.

## MCP Tools

### Memory tools

- `start_context` — required context package for an agent
- `recall` — search memories
- `remember` — create active memory, or proposal for protected categories
- `propose_memory` — create a proposed memory
- `update_memory` — edit an active memory
- `verify_memory` — record usefulness/wrong/outdated feedback
- `list_proposals` — list pending proposed memories
- `delete_memory` — admin-only tombstone a memory
- `approve_proposal` — admin-only activate, edit, or reject a proposal
- `resolve_conflict` — admin-only resolve conflicts between memories

### Session tools

- `start_session` — start a new Librarian session attributed to the calling agent
- `get_session` / `list_sessions` / `list_session_events` / `search_sessions` — read operations
- `record_session_event` — append a typed evidence event (decision, command, file, error, question, etc.); implicitly resumes a paused session
- `checkpoint_session` / `pause_session` / `end_session` — explicit lifecycle
- `attach_session` / `continue_session` — cross-harness attachment + handover (continue defaults to attach in the same call)
- `archive_session` / `restore_session` / `delete_session` — hide / restore / soft-delete (delete and restore are owner-or-admin)
- `promote_session_fact` — promote a session fact into a durable memory; protected categories route through the proposal flow

Visibility filtering is enforced at the MCP dispatch layer: each agent sees only `common` sessions plus their own `agent_private` sessions. Admin role bypasses.

### Authentication

The mcp-server protects every meaningful surface with a token:

- `/mcp` — Bearer agent or admin token. Admin-only tools (proposal approval, deletion, conflict resolution) require the admin token.
- `/trpc/*` — admin token only. The Next.js dashboard injects this on the server side via its `/api/trpc/[trpc]` proxy and Server Actions; it never touches the browser.
- `/healthz` — unauthenticated.

For stronger `agent_private` isolation and per-agent session attribution, set `LIBRARIAN_AGENT_TOKENS` to comma-separated `agent_id:token` pairs so each agent is pinned to its authenticated identity.

## Sessions

The session layer is the neutral handover surface across harnesses. Full spec: [`specs/session-layer-and-harness-packages.md`](./specs/session-layer-and-harness-packages.md). Highlights:

- **List-and-select resume.** `list_sessions` returns ranked candidates (by status, project match, source match, has-next-steps, recency) and never auto-selects. Numbered entries in the slash UX are agent-side scratch; every tool call uses the canonical `session_id`.
- **Explicit lifecycle.** `active` → `paused` / `ended`, with `archived` and `deleted` as hidden states. Restore returns a session to its `prior_status` (paused as a fallback). Recording activity on a paused session implicitly resumes it.
- **Common by default.** Visibility defaults to `common` because cross-agent handover is the point. Agents scan for sensitivity signals (identity, secrets, personal context, sensitive debugging) and confirm before starting a `common` session whose content looks private. `agent_private` is opt-in.
- **Evidence, not memory.** Session history is evidence; durable facts are promoted explicitly via `promote_session_fact` (or via `end_session`'s `candidate_memories`). Nothing auto-promotes.
- **Both ledgers rebuild.** `pnpm run rebuild` replays `events.jsonl` and `sessions.jsonl` into the SQLite projection. Deleting `librarian.sqlite` is recoverable.

## CLI

The `the-librarian` binary exposes the full session lifecycle from any shell, alongside the existing `rebuild` and `seed`:

```sh
the-librarian sessions start --title "Refactor auth" --harness codex --cwd "$PWD"
the-librarian sessions list --project the-librarian
the-librarian sessions continue ses_… --format markdown
the-librarian sessions checkpoint ses_… --summary-file checkpoint.md
the-librarian sessions pause ses_…
the-librarian sessions end ses_… --summary-file end.md
the-librarian sessions archive ses_… --reason "throwaway spike"
the-librarian sessions restore ses_…
the-librarian sessions delete ses_… --reason "test session"
the-librarian sessions search "BM25 recall" --project the-librarian
the-librarian sessions show ses_…
the-librarian sessions events ses_… --type decision --limit 50
```

Every verb supports `--json` for machine-readable output, `--agent <id>` to set the calling agent, and `--admin` to elevate to admin role (required for cross-agent delete/restore). `continue` supports `--format prose|markdown|claude|codex|opencode|hermes|pi` and `--no-attach` for preview-only handover.

## Slash commands

The canonical cross-harness slash surface is `/lib:session <verb>`. The contract lives in [`docs/slash-commands.md`](./docs/slash-commands.md). Each harness implements it with whatever native pattern fits best:

- **Claude Code** and **OpenCode** ship per-verb commands (`/lib-session-start`, `/lib-session-list`, `/lib-session-resume`, etc.) — see `integrations/<harness>/commands/`. Eleven thin markdown files, one per verb; the agent calls the corresponding MCP tool with the right scoping.
- **Hermes** registers a single `/lib:session` command and parses the remainder.
- **Codex** and **Pi** are documented but their per-verb story is deferred (the Codex CLI has no user-invokable slash primitive today; Pi's runtime interface is an open question per the spec).

## Harness integrations

Copyable setup packages live under [`integrations/`](./integrations/):

```text
integrations/
  README.md                # file conventions across packages
  hermes/                  # AGENTS.append.md snippet for Hermes's existing AGENTS.md
  claude-code/             # standalone CLAUDE.md + commands/ + wrapper.sh
  codex/                   # AGENTS.md + wrapper.sh
  opencode/                # AGENTS.md + commands/ + wrapper.sh
  pi/                      # conservative MVP — capture defaults to summary, never log
```

Each package ships an MCP config example, install steps, the `/lib:session` contract for that harness, the slash-command mapping, a wrapper script (where useful) that brackets the harness binary with `sessions start` on launch and `sessions pause` on exit and exposes `LIBRARIAN_SESSION_ID` to child processes, plus an end-to-end healthcheck.

## Protected Memory

The `identity` and `relationship` categories are proposal-only. Agents can propose these memories, but they cannot activate them directly. Promotion of session facts into these categories via `promote_session_fact` routes through the proposal flow regardless of caller role.

## Agent Policy

Agents should:

1. Call `start_context` at the start of meaningful interactions.
2. Recall relevant project/tool/environment context for non-trivial tasks.
3. Save durable lessons through `remember`.
4. Use proposals for identity, relationship, and major preference changes.
5. Verify memories that helped, misled, or became stale.
6. Use `/lib:session start` to bound non-trivial work, and `/lib:session checkpoint` / `pause` / `end` to make handover possible across harnesses.
7. Never auto-promote session content to durable memory — let the user direct.

## Agent Skill

This repo includes a reusable skill for agents:

```text
skills/use-the-librarian/SKILL.md
```

Install or copy that skill into any agent environment that supports skills. It explains when to call each MCP method, what should and should not be remembered, how to handle protected identity and relationship memory, and how to keep common memory separate from agent-private memory.

For agents that do not reliably auto-discover skills, this repo also includes a minimal [SOUL.md](./SOUL.md) that points them to the skill and states the required memory behavior.

## Commands

```sh
pnpm start                                # MCP stdio server
pnpm run serve                            # mcp-server (HTTP) at :3838
pnpm --filter @librarian/dashboard dev    # dashboard at :3000
pnpm run seed                             # seed sample memories
pnpm run rebuild                          # replay both JSONL ledgers into the SQLite projection
pnpm run healthcheck                      # five-check end-to-end smoke (JSONL append, rebuild, lifecycle, stdio MCP, HTTP MCP+auth)
pnpm run healthcheck -- --remote <url>    # probe a deployed stack via /healthz + /mcp
pnpm test                                 # full test suite (Vitest across all packages + root test/)
```

## Remote Server

This repository provides the storage engine, MCP stdio + HTTP server, tRPC admin API, and Next.js dashboard. For Docker Compose / Tailnet deployment, see [DEPLOYMENT.md](./DEPLOYMENT.md).

## Outstanding work

See [TODO.md](./TODO.md) for the current outstanding list — `LIBRARIAN_AGENT_TOKENS` wiring on the canonical instance, the standing dashboard redesign + simplification items, and the deferred cross-harness items (Codex slash surface, Pi runtime).

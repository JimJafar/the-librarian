# The Librarian

[![CI](https://github.com/JimJafar/the-librarian/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/JimJafar/the-librarian/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

A portable **memory + session layer for AI agents**. The Librarian gives agents
one disciplined funnel for recalling, proposing, saving, updating, and reviewing
durable context — plus a neutral **cross-harness session-continuity layer** so
work started in one harness (Claude Code, Codex, Hermes, OpenCode, Pi) can be
handed off and resumed cleanly in another.

It runs as a small self-hosted server, reachable locally or over the network.

## Features

- **Durable memory** — `recall` / `remember` / `verify` with categories, scoping
  (`common` vs `agent_private`), a proposal flow for protected categories, and a
  three-state (`active` / `proposed` / `archived`) model.
- **Cross-harness sessions** — start / checkpoint / pause / end / continue, with
  a handover package any harness can resume. Session history is *evidence*;
  durable facts are promoted explicitly.
- **Memory curator** — an optional scheduled LLM pass that grooms memory
  (dedupe, archive stale, refine), configured and observed from the dashboard.
- **Dashboard** — a Next.js admin cockpit (Memories, Sessions, Recall,
  Proposals, Archive, Logs, Analytics, Curator) with a ⌘K command palette.
- **Harness integrations** — standalone installable plugins for Claude Code,
  Codex, Hermes, and Pi (their own repos); a copyable setup package under
  [`integrations/`](./integrations/) for OpenCode.

Event-sourced and dependency-light: append-only JSONL ledgers + a generated
SQLite/FTS5 index over the built-in `node:sqlite` — no external database to run.

## Quick start

### Docker (recommended for a VPS)

```sh
cp .env.example .env   # optional — auth/secret vars auto-generate
docker compose --env-file .env -f docker/docker-compose.yml up -d --build
```

A fresh install needs **zero** auth/secret env vars: `LIBRARIAN_ADMIN_TOKEN` and
`LIBRARIAN_SECRET_KEY` auto-generate on first boot (watch the log for the
one-time values), and you enable owner login from the dashboard. Full deploy
guide: [DEPLOYMENT.md](./DEPLOYMENT.md).

### Local dev (two services)

Requirements: **Node 22.5+** and **pnpm 9.15.x** via Corepack:

```sh
corepack enable && corepack prepare pnpm@9.15.0 --activate
pnpm install
pnpm run seed                               # seed sample memories
pnpm run serve                              # mcp-server at http://127.0.0.1:3838
pnpm --filter @librarian/dashboard dev      # dashboard at http://127.0.0.1:3000
```

```sh
pnpm run healthcheck                              # local end-to-end smoke
pnpm run healthcheck -- --remote http://host:3838 # probe a deployed instance
```

## Configuration

Auth and secrets are managed from the dashboard at **`/settings/auth`** (password
and/or GitHub/Google), enforced without a redeploy. Agent tokens are
dashboard-managed too. A fresh install needs **zero** auth/secret env vars;
`LIBRARIAN_ADMIN_TOKEN` and `LIBRARIAN_SECRET_KEY` auto-generate on first boot.

For the host/port, data dir, and the legacy env-configured auth path, see
[DEPLOYMENT.md](./DEPLOYMENT.md).

## MCP tools

Agents talk to the Librarian over `/mcp` with a bearer token.

### Memory

- `start_context` — required context package for an agent.
- `recall` — search memories (`active` only by default; pass
  `include_ids: true` for `[mem_…]`-prefixed lines so callers can `verify`).
- `remember` — create an active memory, or a proposal for protected categories.
- `propose_memory` — create a proposed memory.
- `update_memory` — edit an active memory.
- `verify_memory` — record a verdict: `useful` / `not_useful` move recall rank
  by ±1 (clamped ±3); `outdated` archives the memory.
- `list_proposals` — list pending proposals.
- `archive_memory` *(admin)* — archive a memory.
- `approve_proposal` *(admin)* — activate, edit, or reject a proposal.

Memories are `active`, `proposed`, or `archived`. The `identity` and
`relationship` categories are **proposal-only**: agents propose, a human
approves.

### Sessions

- `start_session` — start a session attributed to the calling agent.
- `get_session` / `list_sessions` / `list_session_events` / `search_sessions` — reads.
- `record_session_event` — append a typed evidence event.
- `checkpoint_session` / `pause_session` / `end_session` — explicit lifecycle.
- `attach_session` / `continue_session` — cross-harness attach + handover.
- `promote_session_fact` — promote a session fact to a durable memory.

Sessions are `active`, `paused`, or `ended`. Resuming an `ended` session flips
it back to `paused`; the next recorded event flips it to `active`. Each agent
sees `common` sessions plus its own `agent_private`; admin bypasses.

## Slash commands

The canonical cross-harness surface is `/lib:session <verb>`; the contract is in
[`docs/slash-commands.md`](./docs/slash-commands.md). Each harness implements it
natively — Claude Code and OpenCode ship per-verb commands
(`/lib-session-start`, `/lib-session-resume`, …) plus `/lib-toggle-private`.

## Dashboard

The Next.js admin cockpit (port `3000`) surfaces **Memories**, **Sessions**,
**Recall** (two-pane timeline + insights), **Proposals**, **Archive**, **Logs**,
**Analytics**, and the **Curator** cockpit — reachable from a persistent top nav
and a ⌘K command palette (`?` shows shortcuts). Owner login is configured from
**Settings → Auth**; the admin token never reaches the browser.

## CLI

The `the-librarian` binary runs the full session lifecycle against a local
store, alongside `rebuild`, `seed`, `backup`/`restore`/`export`, and `auth`:

```sh
the-librarian sessions start --title "Refactor auth" --harness codex --cwd "$PWD"
the-librarian sessions list --project the-librarian
the-librarian sessions continue ses_… --format markdown
the-librarian sessions checkpoint ses_… --summary-file checkpoint.md
the-librarian sessions pause ses_…
the-librarian sessions end ses_…
the-librarian sessions search "BM25 recall" --project the-librarian

the-librarian auth status                              # configured methods (no secrets)
the-librarian auth reset-password                      # set a new owner password
the-librarian auth disable                             # break-glass: turn enforcement off
```

Every verb supports `--json`, `--agent <id>`, and `--admin`. `continue`
supports `--format prose|markdown|claude|codex|opencode|hermes|pi` and
`--no-attach`.

## Memory curator

The curator is an **optional, scheduled LLM pass** that grooms the memory store
— deduping, archiving stale entries, refining wording — configured and observed
from the dashboard **Curator** cockpit (`/curator`). The curator's LLM API
token is encrypted at rest with `LIBRARIAN_SECRET_KEY`. Spec:
[`docs/specs/done/memory-curator-spec.md`](./docs/specs/done/memory-curator-spec.md).

## Harness integrations

Standalone, installable plugins (their own repos):

- **Claude Code** — [`the-librarian-claude-plugin`](https://github.com/JimJafar/the-librarian-claude-plugin)
- **Codex** — [`the-librarian-codex-plugin`](https://github.com/JimJafar/the-librarian-codex-plugin)
- **Hermes** — [`the-librarian-hermes-plugin`](https://github.com/JimJafar/the-librarian-hermes-plugin)
- **Pi** — [`the-librarian-pi-extension`](https://github.com/JimJafar/the-librarian-pi-extension)

OpenCode hasn't graduated to a standalone plugin yet — its copyable setup
package lives under [`integrations/opencode/`](./integrations/opencode/),
built on a shared lifecycle helper (`@librarian/lifecycle`).

## Agent skill

A reusable skill lives at
[`skills/use-the-librarian/SKILL.md`](./skills/use-the-librarian/SKILL.md) —
copy it into any skill-aware agent. The Claude Code plugin ships this skill
directly.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the workspace layout, "where to
add what" recipes (new MCP tool / tRPC procedure / dashboard page / CLI verb),
and local test/lint commands.

Specs and TODOs live in [`docs/`](./docs/); completed specs are archived in
[`docs/specs/done/`](./docs/specs/done/).

## License

Apache-2.0.

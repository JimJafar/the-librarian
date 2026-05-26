# The Librarian

[![CI](https://github.com/JimJafar/the-librarian/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/JimJafar/the-librarian/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

A portable **memory + session layer for AI agents**. The Librarian gives agents
one disciplined funnel for recalling, proposing, saving, updating, and reviewing
durable context — plus a neutral **cross-harness session-continuity layer** so
work started in one harness (Claude Code, Codex, Hermes, OpenCode, Pi) can be
handed off and resumed cleanly in another.

It runs as a small self-hosted server, reachable locally or over the network.

## Harness integrations

A standalone plugin per harness — pick yours, copy the install, set two env
vars (`LIBRARIAN_MCP_URL` + `LIBRARIAN_AGENT_TOKEN`), restart.

<p align="left">
  <a href="https://github.com/JimJafar/the-librarian-claude-plugin"><img src="https://raw.githubusercontent.com/lobehub/lobe-icons/refs/heads/master/packages/static-png/dark/claude.png" alt="Claude Code" height="72"></a>
  <a href="https://github.com/JimJafar/the-librarian-codex-plugin"><img src="https://raw.githubusercontent.com/lobehub/lobe-icons/refs/heads/master/packages/static-png/dark/codex.png" alt="Codex" height="72"></a>
  <a href="https://github.com/JimJafar/the-librarian-hermes-plugin"><img src="https://raw.githubusercontent.com/lobehub/lobe-icons/refs/heads/master/packages/static-png/light/hermesagent.png" alt="Hermes" height="72"></a>
  <a href="https://www.npmjs.com/package/the-librarian-opencode-plugin"><img src="https://raw.githubusercontent.com/lobehub/lobe-icons/refs/heads/master/packages/static-png/dark/opencode.png" alt="OpenCode" height="72"></a>
  <a href="https://github.com/JimJafar/the-librarian-pi-extension"><img src="https://pi.dev/logo-auto.svg" alt="Pi" height="72"></a>
</p>

<details>
<summary><strong>Claude Code</strong> · <a href="https://github.com/JimJafar/the-librarian-claude-plugin">the-librarian-claude-plugin</a></summary>

In Claude Code:

```
/plugin marketplace add JimJafar/the-librarian-claude-plugin
/plugin install the-librarian@the-librarian
```

Set `LIBRARIAN_MCP_URL` and `LIBRARIAN_AGENT_TOKEN` in your shell profile,
restart Claude Code. [Full docs →](https://github.com/JimJafar/the-librarian-claude-plugin#install)

</details>

<details>
<summary><strong>Codex</strong> · <a href="https://github.com/JimJafar/the-librarian-codex-plugin">the-librarian-codex-plugin</a></summary>

```sh
codex plugin marketplace add JimJafar/the-librarian-codex-plugin
codex plugin install the-librarian@the-librarian-codex-local
```

Set the two env vars, restart Codex, and approve the four hooks
(`SessionStart`, `UserPromptSubmit`, `PostCompact`, `Stop`) via `/hooks`.
[Full docs →](https://github.com/JimJafar/the-librarian-codex-plugin#install)

</details>

<details>
<summary><strong>Hermes</strong> · <a href="https://github.com/JimJafar/the-librarian-hermes-plugin">the-librarian-hermes-plugin</a></summary>

```sh
hermes plugins install JimJafar/the-librarian-hermes-plugin
hermes memory setup            # pick "librarian", paste the endpoint
hermes plugins enable librarian
hermes gateway restart
```

Set `LIBRARIAN_AGENT_TOKEN` in the shell `hermes gateway` runs under.
[Full docs →](https://github.com/JimJafar/the-librarian-hermes-plugin#install)

</details>

<details>
<summary><strong>OpenCode</strong> · <a href="https://github.com/JimJafar/the-librarian-opencode-plugin">the-librarian-opencode-plugin</a> · <a href="https://www.npmjs.com/package/the-librarian-opencode-plugin">npm</a></summary>

```sh
opencode plugin the-librarian-opencode-plugin
```

Then add an `mcpServers.librarian` block to your `opencode.json` (4 lines —
[shown in the plugin README](https://github.com/JimJafar/the-librarian-opencode-plugin#2-wire-the-mcp-server))
and set the two env vars. First `session.created` auto-installs the seven
`/lib-session-*` slash commands to `~/.config/opencode/commands/`.

</details>

<details>
<summary><strong>Pi</strong> · <a href="https://github.com/JimJafar/the-librarian-pi-extension">the-librarian-pi-extension</a></summary>

```sh
export LIBRARIAN_MCP_URL="https://your-librarian/mcp"
export LIBRARIAN_AGENT_TOKEN="<your-token>"
pi install git:github.com/JimJafar/the-librarian-pi-extension
```

That's it — memory tools and the session lifecycle are live.
[Full docs →](https://github.com/JimJafar/the-librarian-pi-extension#install)

</details>

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

# The Librarian

[![CI](https://github.com/JimJafar/the-librarian/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/JimJafar/the-librarian/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**The Librarian is a living, markdown-native knowledge graph for AI agents — with
a resident curator that tends it.** Knowledge, skills, and context accumulate as
plain, Obsidian-flavoured markdown notes, linked into a graph by `[[wikilinks]]`;
a resident "librarian" curates the collection as it grows — filing each new memory
where it belongs, linking it to its neighbours, and organising the whole for
*retrieval*, not just storage. It's all plain files you can read, edit, and
reorganise yourself (in the dashboard or in Obsidian); git gives it history;
nothing is locked in a database.

Practically, that makes it a portable **memory + handoff layer for AI agents**:
one disciplined funnel for recalling, proposing, saving, updating, and reviewing
durable context — plus an explicit **cross-harness handoff surface** so work
started in one harness (Claude Code, Codex, Hermes, OpenCode, Pi) can be packaged
into a single document and picked up cleanly in another.

It runs as a small self-hosted server, reachable locally or over the network.

## Harness integrations

A standalone plugin per harness — pick yours, copy the install, set two env
vars (`LIBRARIAN_MCP_URL` + `LIBRARIAN_AGENT_TOKEN`), restart.

<p align="left">
  <a href="https://github.com/JimJafar/the-librarian-claude-plugin"><img src="https://img.shields.io/badge/Claude_Code-D97757?logo=anthropic&logoColor=white&style=for-the-badge" alt="Claude Code"></a>
  <a href="https://github.com/JimJafar/the-librarian-codex-plugin"><img src="https://img.shields.io/badge/Codex-412991?logo=openai&logoColor=white&style=for-the-badge" alt="Codex"></a>
  <a href="https://github.com/JimJafar/the-librarian-hermes-plugin"><img src="./assets/harness-badges/hermes.svg" alt="Hermes" height="28"></a>
  <a href="https://www.npmjs.com/package/the-librarian-opencode-plugin"><img src="https://img.shields.io/badge/OpenCode-F38020?logo=npm&logoColor=white&style=for-the-badge" alt="OpenCode"></a>
  <a href="https://github.com/JimJafar/the-librarian-pi-extension"><img src="https://img.shields.io/badge/Pi-2563EB?style=for-the-badge" alt="Pi"></a>
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
and set the two env vars. First `session.created` auto-installs the
`/handoff`, `/takeover`, `/learn`, `/toggle-private` commands to
`~/.config/opencode/commands/`.

</details>

<details>
<summary><strong>Pi</strong> · <a href="https://github.com/JimJafar/the-librarian-pi-extension">the-librarian-pi-extension</a></summary>

```sh
export LIBRARIAN_MCP_URL="https://your-librarian/mcp"
export LIBRARIAN_AGENT_TOKEN="<your-token>"
pi install git:github.com/JimJafar/the-librarian-pi-extension
```

That's it — memory tools and the handoff surface are live.
[Full docs →](https://github.com/JimJafar/the-librarian-pi-extension#install)

</details>

## Features

- **Durable memory** — `recall` / `remember` / `verify` with categories, scoping
  (`common` vs `agent_private`), a proposal flow for protected categories, and a
  three-state (`active` / `proposed` / `archived`) model.
- **Cross-harness handoffs** — `/handoff` packages the work in a five-section
  document; `/takeover` claims it atomically in another agent / harness; `/learn`
  promotes lessons from the conversation into memory proposals.
- **Memory curator** — an optional scheduled LLM pass that grooms memory
  (dedupe, archive stale, refine), configured and observed from the dashboard.
- **Dashboard** — a Next.js admin cockpit (Memories, Handoffs, Recall,
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

### Handoffs

- `store_handoff` — store a handoff document (five required headings) for the
  next agent / harness to pick up.
- `list_handoffs` — list handoffs in the current domain / project / cwd.
- `claim_handoff` — atomically claim a handoff by id.

Handoffs are domain-isolated by default. Claiming is one-shot per handoff —
once claimed, the row is closed to other callers.

## Slash commands

The cross-harness surface is four verbs: `/handoff`, `/takeover`, `/learn`,
`/toggle-private`. The contract is in
[`docs/slash-commands.md`](./docs/slash-commands.md). Each harness implements
them natively — Claude Code and OpenCode ship them as per-verb commands;
`/toggle-private` is enforced by a synchronous local hook, not an MCP call.

## Dashboard

The Next.js admin cockpit (port `3000`) surfaces **Memories**, **Handoffs**,
**Recall** (two-pane timeline + insights), **Proposals**, **Archive**, **Logs**,
**Analytics**, and the **Curator** cockpit — reachable from a persistent top nav
and a ⌘K command palette (`?` shows shortcuts). Owner login is configured from
**Settings → Auth**; the admin token never reaches the browser.

## CLI

The `the-librarian` binary runs `rebuild`, `seed`, `backup`/`restore`/`export`,
`auth`, and `handoffs`:

```sh
the-librarian handoffs list --project the-librarian
the-librarian handoffs show hof_…
the-librarian handoffs purge hof_… --admin

the-librarian auth status                              # configured methods (no secrets)
the-librarian auth reset-password                      # set a new owner password
the-librarian auth disable                             # break-glass: turn enforcement off
```

Every handoff verb supports `--json`, `--agent <id>`, `--admin`, and the
domain / project / cwd / harness scope flags.

## Memory curator

The curator is an **optional, scheduled LLM pass** that grooms the memory store
— deduping, archiving stale entries, refining wording — configured and observed
from the dashboard **Curator** cockpit (`/curator`). The curator's LLM API
token is encrypted at rest with `LIBRARIAN_SECRET_KEY`. Spec:
[`docs/specs/done/013-memory-curator-spec.md`](./docs/specs/done/013-memory-curator-spec.md).

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

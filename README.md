# The Librarian

The Librarian is a portable memory system for AI agents. It gives agents one disciplined funnel for recalling, proposing, saving, updating, and reviewing durable context.

This MVP is intentionally local-first and dependency-light:

- canonical append-only JSONL event log
- generated human-readable memory snapshot
- generated SQLite + FTS5 query index
- MCP-compatible stdio server
- editable local dashboard

## Quick Start

```sh
npm run seed
npm run serve
```

Open the dashboard at:

```text
http://0.0.0.0:3838
```

Run the MCP server:

```sh
npm start
```

Run the production-style HTTP service:

```sh
LIBRARIAN_ADMIN_TOKEN=dev-admin-token LIBRARIAN_AGENT_TOKEN=dev-agent-token npm run serve
```

The MCP-compatible JSON-RPC-over-HTTP endpoint is available at:

```text
http://0.0.0.0:3838/mcp
```

## Data Layout

By default, data is stored in `./data`.

Override with:

```sh
LIBRARIAN_DATA_DIR=/path/to/librarian-data npm start
```

Files:

- `events.jsonl`: canonical append-only event log
- `librarian.sqlite`: generated SQLite index
- `memories.md`: generated human-readable snapshot

The JSONL event log is the source of truth. SQLite and Markdown can be rebuilt at any time.

## MCP Tools

- `start_context`: required context package for an agent
- `recall`: search memories
- `remember`: create active memory, or proposal for protected categories
- `propose_memory`: create a proposed memory
- `update_memory`: edit an active memory
- `verify_memory`: record usefulness/wrong/outdated feedback
- `list_proposals`: list pending proposed memories
- `delete_memory`: admin-only tombstone a memory
- `approve_proposal`: admin-only activate, edit, or reject a proposal
- `resolve_conflict`: admin-only resolve conflicts between memories

Remote HTTP deployments keep token authentication on the `/mcp` endpoint. The dashboard and its browser API are unauthenticated, so run them only on localhost, behind your own access control, or inside a private network such as a Tailnet. Agents should use the agent token for `/mcp`; approval, deletion, and conflict-resolution MCP tools require admin authorization. For stronger `agent_private` isolation, set `LIBRARIAN_AGENT_TOKENS` to comma-separated `agent_id:token` pairs so each agent is pinned to its authenticated identity.

## Protected Memory

The `identity` and `relationship` categories are proposal-only. Agents can propose these memories, but they cannot activate them directly.

## Agent Policy

Agents should:

1. Call `start_context` at the start of meaningful interactions.
2. Recall relevant project/tool/environment context for non-trivial tasks.
3. Save durable lessons through `remember`.
4. Use proposals for identity, relationship, and major preference changes.
5. Verify memories that helped, misled, or became stale.

## Agent Skill

This repo includes a reusable skill for agents:

```text
skills/use-the-librarian/SKILL.md
```

Install or copy that skill into any agent environment that supports skills. It explains when to call each MCP method, what should and should not be remembered, how to handle protected identity and relationship memory, and how to keep common memory separate from agent-private memory.

For agents that do not reliably auto-discover skills, this repo also includes a minimal [SOUL.md](./SOUL.md) that points them to the skill and states the required memory behavior.

## Remote Server

This repository provides the storage engine, MCP stdio server, HTTP MCP endpoint, and browser dashboard. For Docker/Tailnet deployment, see [DEPLOYMENT.md](./DEPLOYMENT.md).

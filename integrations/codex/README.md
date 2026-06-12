# The Librarian — Codex integration

[The Librarian](https://github.com/JimJafar/the-librarian) gives
[Codex](https://developers.openai.com/codex) durable, shared memory and
cross-harness handoffs over plain MCP. **No plugin, no code — one config
block.** Modern Codex speaks streamable HTTP MCP natively and renders the
server's `instructions` field as server-wide guidance alongside the tools,
so the Librarian primer and tool descriptions teach the model everything.

This integration replaces the standalone
[`the-librarian-codex-plugin`](https://github.com/JimJafar/the-librarian-codex-plugin)
repo (archived). Its stdio↔HTTP proxy existed only because older Codex
couldn't take an env-var URL for a remote MCP server, and its hook existed
only for per-turn conv-state injection — both needs are gone (conv_state was
retired server-side; Codex now supports HTTP MCP servers directly).

## Install

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.librarian]
url = "https://librarian.example.com/mcp"
bearer_token_env_var = "LIBRARIAN_AGENT_TOKEN"
```

Or via the CLI (the URL is written into `config.toml` literally; the token
stays an env-var *name*, never a value):

```sh
codex mcp add librarian \
  --url "$LIBRARIAN_MCP_URL" \
  --bearer-token-env-var LIBRARIAN_AGENT_TOKEN
```

Then set the token in your shell profile and restart Codex:

```sh
export LIBRARIAN_AGENT_TOKEN="<your-token>"
```

The `/mcp` panel should now list `librarian` with 7 tools.

Config reference: [Codex MCP docs](https://developers.openai.com/codex/mcp)
— `url` (required), `bearer_token_env_var` (sent as the `Authorization`
header), plus `http_headers` / `env_http_headers` if you need extra headers.

## Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `LIBRARIAN_AGENT_TOKEN` | yes | Bearer token. Referenced by *name* in `config.toml`; Codex sends it only in the `Authorization` request header. |
| `LIBRARIAN_MCP_URL` | for the CLI one-liner | The Librarian HTTP MCP URL, e.g. `https://librarian.example.com/mcp`. Codex stores the resolved URL in `config.toml`. |

The Librarian's no-auth mode is **localhost-only** — a remote endpoint must
carry a token over **HTTPS**. On the Librarian host:

```sh
LIBRARIAN_HOST=0.0.0.0 LIBRARIAN_AGENT_TOKENS="codex:<strong-token>" pnpm run serve
```

## What you get

**The 7 Librarian tools:**

| Tool | Purpose |
| --- | --- |
| `recall` | Hybrid search over durable memories — call before answering anything with prior context |
| `remember` | Save a durable fact, preference, or decision — fire-and-forget; the curator files it |
| `flag_memory` | Flag a wrong/outdated memory (reason required) for human review |
| `store_handoff` | Persist a five-section handoff document for another agent to resume |
| `list_handoffs` | List unclaimed handoffs waiting to be picked up |
| `claim_handoff` | Atomically claim a handoff and receive its document |
| `search_references` | Search long-form reference docs (deliberately not auto-recalled) |

**The primer as namespace description:** Codex reads the MCP `instructions`
field returned at initialization and presents it as server-wide guidance
alongside the server's tools. The Librarian serves its ≤2KB primer there
(source: `vault/primer.md` on your server, editable in the dashboard), so
the behavioural loop — recall before answering, remember durable facts,
the handoff protocol, private mode — rides into every Codex session with
zero Codex-side setup.

## The protocols, in natural language

Codex has no Librarian slash commands — the primer carries the protocols,
and the model drives them from what you say:

| You say… | The agent does |
| --- | --- |
| "hand this off" / "we're done for now" | Authors a five-section document — Start & intent, Journey, Current state, What's left, Open questions — and persists it via `store_handoff` |
| "pick up where I left off" / "what was I doing" | `list_handoffs`, presents the candidates, atomically claims your pick with `claim_handoff`, resumes from the document |
| "save what we learned" | Extracts durable lessons, submits the ones you approve via `remember` (one call per lesson; the curator dedupes and files them) |
| "go private" / "back on the record" | Emits the `[librarian:private=on\|off]` marker — pure in-conversation. While private: no `remember`/`store_handoff`/`flag_memory`; `recall`/`search_references` stay allowed (those queries reach the server's logs) |
| "what do I know about …" | `recall` |
| "remember that …" | `remember` |
| (a recalled memory was wrong) | `flag_memory(memory_id, reason)` |

The same protocols work identically in every Librarian harness (Claude
Code, OpenCode, Hermes, Pi) — handoffs stored here are claimable there and
vice versa.

## Troubleshooting

**`/mcp` doesn't list `librarian`.** Verify `LIBRARIAN_AGENT_TOKEN` is set
in the shell that launched Codex, then test the endpoint directly:

```sh
curl -X POST "https://librarian.example.com/mcp" \
  -H "Authorization: Bearer $LIBRARIAN_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

A healthy response lists exactly 7 tools.

**If the server is down**, the tools fail at the harness level and the
primer tells the agent to continue without memory — your turn is never
blocked.

## License

Apache-2.0 (same as the monorepo).

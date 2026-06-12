# The Librarian — Claude Code integration

[The Librarian](https://github.com/JimJafar/the-librarian) gives Claude Code
durable, shared memory and cross-harness handoffs over plain MCP: 7 tools
(`recall`, `remember`, `flag_memory`, `store_handoff`, `list_handoffs`,
`claim_handoff`, `search_references`) plus a ≤2KB primer that Claude Code
loads natively from the MCP server's `instructions` field at connect time.

**The MCP config alone is fully functional.** Claude Code renders the
server's instructions and tool descriptions natively, and those carry every
protocol (the recall/remember loop, the five-section handoff template, the
learn flow, private mode). The plugin below adds only optional sugar: four
slash commands that restate the same protocols as convenient prompts.

This integration replaces the standalone
[`the-librarian-claude-plugin`](https://github.com/JimJafar/the-librarian-claude-plugin)
repo (archived). Its hook machinery — per-turn conv-state injection — was
retired with the server's conv_state surface; nothing here runs code.

## Option A — plain MCP config (no plugin)

Add the server to any scope you like. Project scope (`.mcp.json` in your
project root):

```json
{
  "mcpServers": {
    "librarian": {
      "type": "http",
      "url": "${LIBRARIAN_MCP_URL}",
      "headers": {
        "Authorization": "Bearer ${LIBRARIAN_AGENT_TOKEN}"
      }
    }
  }
}
```

Or user scope, one command (note this writes the *literal* expanded values
into your user config):

```sh
claude mcp add --scope user --transport http librarian "$LIBRARIAN_MCP_URL" \
  --header "Authorization: Bearer $LIBRARIAN_AGENT_TOKEN"
```

Set the env vars in your shell profile and restart Claude Code:

```sh
export LIBRARIAN_MCP_URL="https://librarian.example.com/mcp"
export LIBRARIAN_AGENT_TOKEN="<your-token>"
```

That's everything. The primer arrives via MCP `instructions` at session
start; the 7 tools appear under the `librarian` server.

## Option B — the plugin (Option A + slash commands)

In Claude Code:

```
/plugin marketplace add JimJafar/the-librarian
/plugin install the-librarian@the-librarian
```

Set the same two environment variables (above) and restart Claude Code.
The plugin ships the `.mcp.json` from Option A plus four commands:

| Command | What it does |
| --- | --- |
| `/handoff` | Author a five-section narrative and persist it via `store_handoff` for cross-harness pickup |
| `/takeover` | List candidate handoffs (`list_handoffs`), atomically claim one (`claim_handoff`), inject the document |
| `/learn` | Extract durable lessons from the conversation and submit each via `remember` |
| `/toggle-private` | Flip the `[librarian:private=on\|off]` marker — pure in-conversation, no server state |

All four are thin prompt templates over the primer protocols — saying
"hand this off" or "go private" in plain language works identically.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `LIBRARIAN_MCP_URL` | yes | Librarian HTTP MCP URL, e.g. `https://librarian.example.com/mcp` |
| `LIBRARIAN_AGENT_TOKEN` | yes | Bearer token (only ever sent in the request header) |

### Remote Librarian

The Librarian's no-auth mode is **localhost-only**, so a remote endpoint
**must** carry a token over **HTTPS**. On the Librarian host:

```sh
LIBRARIAN_HOST=0.0.0.0 LIBRARIAN_AGENT_TOKENS="claude-code:<strong-token>" pnpm run serve
```

Then set `LIBRARIAN_MCP_URL` and `LIBRARIAN_AGENT_TOKEN` to match.

## Troubleshooting

**The `librarian` server doesn't appear in `/mcp`.** Verify both env vars
are set in the shell that launched Claude Code, then test the endpoint
directly:

```sh
curl -X POST "$LIBRARIAN_MCP_URL" \
  -H "Authorization: Bearer $LIBRARIAN_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

A healthy response lists exactly 7 tools.

**The agent doesn't follow the protocols.** The primer is served from the
server's `vault/primer.md` (editable in the dashboard); check
`GET <server>/primer.md` returns it. Claude Code truncates server
instructions at ~2KB — the server enforces the same cap on save.

## License

Apache-2.0 (same as the monorepo).

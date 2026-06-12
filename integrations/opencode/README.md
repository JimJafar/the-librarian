# The Librarian — OpenCode integration

[The Librarian](https://github.com/JimJafar/the-librarian) gives
[opencode](https://opencode.ai) durable, shared memory and cross-harness
handoffs over plain MCP. **No plugin, no code — two config entries** in
`opencode.json`: one MCP server block for the 7 tools, one `instructions`
line that loads the Librarian primer from your server.

This integration replaces the standalone
[`the-librarian-opencode-plugin`](https://github.com/JimJafar/the-librarian-opencode-plugin)
npm package (retired). Its per-turn injection hook
(`chat.system.transform`) existed to carry conv-state, which was retired
server-side; the primer now rides opencode's own remote-URL `instructions`
config, and the plugin's slash commands were optional sugar — shipped here
as plain markdown files instead (see [Optional commands](#optional-commands)).

## Install

Add to your `opencode.json` (global `~/.config/opencode/opencode.json` or
per-project), replacing `librarian.example.com` with your server:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "librarian": {
      "type": "remote",
      "url": "https://librarian.example.com/mcp",
      "enabled": true,
      "headers": {
        "Authorization": "Bearer {env:LIBRARIAN_AGENT_TOKEN}"
      }
    }
  },
  "instructions": ["https://librarian.example.com/primer.md"]
}
```

Set the token in your shell profile and restart opencode:

```sh
export LIBRARIAN_AGENT_TOKEN="<your-token>"
```

That's everything. The 7 Librarian tools appear under `librarian`, and the
primer loads into the model's instructions at session start.

### Why this exact shape (sources)

- **`mcp` block:** opencode's config schema (`@opencode-ai/sdk`
  `McpRemoteConfig`; [opencode.ai/docs/mcp-servers](https://opencode.ai/docs/mcp-servers))
  — remote servers take `type: "remote"`, `url`, optional `headers` and
  `enabled`. Env vars substitute with `{env:VAR_NAME}`
  ([opencode.ai/docs/config](https://opencode.ai/docs/config)); an unset
  variable substitutes as an empty string, so a missing token fails at the
  server, never in your config.
- **`instructions` line:** opencode's `instructions` config takes an array
  of paths, globs, **or remote URLs** — "You can also use remote URLs to
  load instructions from the web"
  ([opencode.ai/docs/rules](https://opencode.ai/docs/rules)). The Librarian
  serves its ≤2KB primer unauthenticated at `GET /primer.md` precisely for
  this. Note: remote instructions are fetched with a 5-second timeout; if
  the server is down the primer is simply skipped — your session still
  starts. (opencode does **not** honor MCP `initialize` instructions, which
  is why this line exists.)

## What you get

| Tool | Purpose |
| --- | --- |
| `recall` | Hybrid search over durable memories — call before answering anything with prior context |
| `remember` | Save a durable fact, preference, or decision — fire-and-forget; the curator files it |
| `flag_memory` | Flag a wrong/outdated memory (reason required) for human review |
| `store_handoff` | Persist a five-section handoff document for another agent to resume |
| `list_handoffs` | List unclaimed handoffs waiting to be picked up |
| `claim_handoff` | Atomically claim a handoff and receive its document |
| `search_references` | Search long-form reference docs (deliberately not auto-recalled) |

The primer (served from `vault/primer.md` on your server, editable in the
dashboard) teaches the behavioural loop: recall before answering, remember
durable facts, the handoff protocol, the learn protocol, private mode, and
"never block the user's work if the server is unreachable." Saying "hand
this off", "pick up where I left off", "save what we learned", or "go
private" in plain language is the whole interface — handoffs stored here
are claimable from any other Librarian harness (Claude Code, Codex, Hermes,
Pi) and vice versa.

## Optional commands

opencode auto-discovers command markdown files from
`~/.config/opencode/commands/` (global) or `.opencode/commands/`
(per-project) — [opencode.ai/docs/commands](https://opencode.ai/docs/commands).
The four files in [`commands/`](./commands) restate the primer protocols as
`/handoff`, `/takeover`, `/learn`, and `/toggle-private` pickers (identical
wording to the Claude Code plugin's commands):

```sh
cp integrations/opencode/commands/*.md ~/.config/opencode/commands/
```

Restart opencode and they appear in the `/` picker. They are sugar — the
natural-language phrases above do the same thing without them.

## Troubleshooting

**The `librarian` tools don't appear.** Verify `LIBRARIAN_AGENT_TOKEN` is
exported in the shell that launched opencode, then test the endpoint
directly:

```sh
curl -X POST "https://librarian.example.com/mcp" \
  -H "Authorization: Bearer $LIBRARIAN_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

A healthy response lists exactly 7 tools.

**The primer doesn't seem loaded.** Check it serves:
`curl https://librarian.example.com/primer.md` (no auth needed — only this
route is unauthenticated). Remember the 5-second fetch timeout: a slow or
unreachable server skips the primer for that session.

**Remote server security.** The Librarian's no-auth mode is
**localhost-only** — a remote endpoint must carry a token over **HTTPS**.
On the Librarian host:

```sh
LIBRARIAN_HOST=0.0.0.0 LIBRARIAN_AGENT_TOKENS="opencode:<strong-token>" pnpm run serve
```

## License

Apache-2.0 (same as the monorepo).

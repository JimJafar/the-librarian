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
repo (archived). Its old per-turn conv-state injection was retired with the
server's conv_state surface. The plugin now ships a new, fail-soft set of hooks
for **automatic capture** and **awareness** (see
[Automatic capture & awareness](#automatic-capture--awareness) below).

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

## Automatic capture & awareness

The plugin ships a small set of fail-soft hooks (in
[`hooks/hooks.json`](./hooks/hooks.json) + [`scripts/`](./scripts)) that make the
Librarian the thing your memory flows through, without relying on the agent to
remember the verbs (spec `2026-06-16-harness-auto-capture`, ADR 0009):

| Hook | Script | What it does |
| --- | --- | --- |
| `UserPromptSubmit` (primary), `Stop`, `SessionEnd` | `on-stop.mjs` | Tail the conversation transcript from a byte-offset cursor and ship each turn's delta to the server (`POST /transcript`), which extracts durable lessons for you — **zero agent memory calls**. Driven by `UserPromptSubmit` because Claude bug [#29767](https://github.com/anthropics/claude-code/issues/29767) means plugin-scoped `Stop` hooks register but never fire; `Stop` / `SessionEnd` stay wired so capture **auto-recovers** when the bug is fixed. `SessionEnd` is the explicit-end accelerator (the server extracts immediately instead of waiting out the idle window). |
| `PreToolUse` (`Write\|Edit\|MultiEdit`) | `block-memory-write.mjs` | Block writes to Claude's **native memory store** (`**/.claude/**/memory/**`) and redirect you to the `remember` tool — durable facts belong in the shared Librarian, not a local `MEMORY.md` the next session/agent/harness can't see. Narrow by design (only the native store) and **fail-open**. |
| `SessionStart` | `on-session-start.mjs` | Inject a deterministic banner: you have `recall`/`remember`, plus the current **capture status** (warns, with the fix, when capture is off). Re-fires after a compaction, so the awareness survives it. |

**Capture is default-on**, gated two ways:

- **Per-turn private skip.** A turn under `[librarian:private=on]` is never
  shipped (forward-only — a private-then-public sequence never retroactively
  ships the private turns).
- **`LIBRARIAN_AUTO_SAVE=false`** — the per-machine kill-switch: set it and the
  capture hook ships and buffers nothing on this machine.
- **Server-authoritative** — the server buffers only when its curator intake gate
  (`curator.intake.enabled`, toggled in the dashboard) is on; the SessionStart
  banner warns when it is off.

Every hook is fail-soft: a Librarian/network/parse error never blocks your turn,
never leaks a stack trace into the model's context, and errs toward *not*
capturing. The cursor and a one-line skip log live under
`${CLAUDE_PLUGIN_DATA:-$HOME/.librarian/claude-plugin-data}/`.

For the per-harness status of automatic capture (Claude authoritative; Pi/Hermes
feasible; OpenCode feasible-with-caveats; Codex blocked), see the
[harness-capture capability matrix](../../docs/harness-capture-capability.md).

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `LIBRARIAN_MCP_URL` | yes | Librarian HTTP MCP URL, e.g. `https://librarian.example.com/mcp` |
| `LIBRARIAN_AGENT_TOKEN` | yes | Bearer token (only ever sent in the request header) |
| `LIBRARIAN_AUTO_SAVE` | no | Set to `false` to disable automatic capture on this machine (default-on). Anything else (unset, `true`, …) leaves capture on. |

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

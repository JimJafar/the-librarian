# Claude Code integration

Wires Claude Code (Anthropic's CLI / IDE extensions / web app) into The Librarian's session layer.

## Install

1. **Add the MCP server to Claude Code.** Copy [`mcp.example.json`](./mcp.example.json) into your Claude Code MCP configuration (or merge with an existing one). The endpoint points at the canonical Librarian HTTP MCP. Set `LIBRARIAN_AGENT_TOKEN` in the environment.

2. **Drop `CLAUDE.md` into the project root** (or merge with an existing `CLAUDE.md`). This is a *standalone* file — Claude Code reads it on session start and gets the `lib:` slash-command contract and Claude-specific guidance.

3. **Optionally use [`wrapper.sh`](./wrapper.sh)** to bracket `claude` invocations with `the-librarian sessions start` (on launch) and `pause` (on exit). The wrapper exports `LIBRARIAN_SESSION_ID` so child processes can record events against the right session.
   ```sh
   chmod +x integrations/claude-code/wrapper.sh
   integrations/claude-code/wrapper.sh --project the-librarian -- claude
   ```

4. **Run the healthcheck.** See [`healthcheck.md`](./healthcheck.md).

## Native resume interaction

Claude Code has its own `--resume` mechanism for native session continuation. The Librarian's session layer is **additive**: it does not replace `--resume`, it complements it by providing a neutral, durable handover layer that any harness can read.

- Use Claude's `--resume` for in-session context continuation within Claude.
- Use `/lib:session resume <id>` (or `the-librarian sessions continue <id> --format claude`) when handing the work off to a different harness, or when you want to read the session from outside Claude.

## Native metadata capture

The wrapper reads whatever Claude Code exposes (env vars like `CLAUDE_SESSION_ID` when present, `--resume` target, cwd) and stores it as `source_ref` (in the `claude:session:{id}` form when available, falling back to `cwd:{path}`). Partial data is accepted gracefully — a session without a native Claude id still functions; it just can't round-trip through `--resume`.

## See also

- Canonical slash command contract: [`docs/slash-commands.md`](../../docs/slash-commands.md)
- Full session spec: [`specs/session-layer-and-harness-packages.md`](../../specs/session-layer-and-harness-packages.md)

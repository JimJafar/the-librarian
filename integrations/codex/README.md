# Codex integration

Wires Codex (cwd-oriented coding agent) into The Librarian's session layer.

## Install

1. **Add the MCP server to Codex.** Copy [`mcp.example.json`](./mcp.example.json) into Codex's MCP configuration. Set `LIBRARIAN_AGENT_TOKEN` in the environment.

2. **Drop [`AGENTS.md`](./AGENTS.md) into the project root** (or merge with an existing `AGENTS.md`). Codex reads it on session start and learns the `/lib:session` contract and Codex-specific guidance.

3. **Optionally use [`wrapper.sh`](./wrapper.sh)** to bracket `codex` invocations with `the-librarian sessions start` (on launch) and `pause` (on exit):
   ```sh
   chmod +x integrations/codex/wrapper.sh
   integrations/codex/wrapper.sh --project the-librarian -- codex
   ```

4. **Run the healthcheck.** See [`healthcheck.md`](./healthcheck.md).

## Source ref shape

Codex is cwd-oriented. The wrapper records `source_ref` as `cwd:{absolute_path}` by default. If Codex exposes a native run id (e.g. via env var `CODEX_RUN_ID`), the wrapper uses `codex:run:{run_id}:cwd:{abs_path}` so the handover can name the specific run.

## Handover format

`continue_session --format codex` produces a concise `AGENTS`-style handover suitable for pasting into Codex's system prompt or for consumption by another Codex run.

## See also

- Canonical slash command contract: [`docs/slash-commands.md`](../../docs/slash-commands.md)
- Full session spec: [`specs/done/session-layer-and-harness-packages.md`](../../specs/done/session-layer-and-harness-packages.md)

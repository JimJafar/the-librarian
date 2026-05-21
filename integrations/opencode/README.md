# OpenCode integration

Wires OpenCode into The Librarian's session layer.

## Install

1. **Add the MCP server to OpenCode.** Merge [`opencode.example.json`](./opencode.example.json) into your `opencode.json`. Set `LIBRARIAN_AGENT_TOKEN` in the environment.

2. **Install the per-verb slash commands.** Copy the markdown files in [`commands/`](./commands/) into `.opencode/commands/` (project-local) or `~/.config/opencode/commands/` (global). Each file becomes a native OpenCode slash command with autocomplete:
   ```sh
   mkdir -p .opencode/commands
   cp integrations/opencode/commands/*.md .opencode/commands/
   ```
   You get 7 commands: `/lib-session-start`, `/lib-session-list`, `/lib-session-resume`, `/lib-session-checkpoint`, `/lib-session-pause`, `/lib-session-end`, `/lib-session-search`. Each is a thin prompt that names the MCP tool to call and the scoping defaults.

   Prefer to keep commands in `opencode.jsonc`? Use [`commands.example.json`](./commands.example.json) as an equivalent alternative — same 7 verbs, defined inline under the `command` key.

3. **Drop [`AGENTS.md`](./AGENTS.md) into the project root** (or merge with an existing `AGENTS.md`). OpenCode reads it on session start and learns the session command contract.

4. **Optionally use [`wrapper.sh`](./wrapper.sh)** to bracket `opencode` invocations:
   ```sh
   chmod +x integrations/opencode/wrapper.sh
   integrations/opencode/wrapper.sh --project the-librarian -- opencode
   ```
   The wrapper sets `LIBRARIAN_SESSION_ID` and records harness attachment so the session shows up correctly across `list_sessions` and `continue_session`.

5. **Run the healthcheck.** See [`healthcheck.md`](./healthcheck.md).

## Source ref shape

OpenCode is project-oriented. The wrapper records `source_ref` as `opencode:project:{absolute_path}`. If OpenCode exposes session metadata (e.g. an `OPENCODE_SESSION_ID` env var), the wrapper appends it.

## Handover format

`continue_session --format opencode` produces an OpenCode-friendly context pack suitable for pasting into the OpenCode prompt or consuming by another OpenCode session.

## See also

- Canonical slash command contract: [`docs/slash-commands.md`](../../docs/slash-commands.md)
- Full session spec: [`specs/done/session-layer-and-harness-packages.md`](../../specs/done/session-layer-and-harness-packages.md)

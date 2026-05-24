# Claude Code integration

Wires Claude Code (Anthropic's CLI / IDE extensions / web app) into The Librarian's session layer.

## Install

1. **Add the MCP server to Claude Code.** Copy [`mcp.example.json`](./mcp.example.json) into your Claude Code MCP configuration (or merge with an existing one). The endpoint points at the canonical Librarian HTTP MCP. Set `LIBRARIAN_AGENT_TOKEN` in the environment.

2. **Drop `CLAUDE.md` into the project root** (or merge with an existing `CLAUDE.md`). This is a *standalone* file — Claude Code reads it on session start and gets the session-command contract and Claude-specific guidance.

3. **Install the per-verb slash commands.** Copy the markdown files in [`commands/`](./commands/) into your `.claude/commands/` directory (project-local) or `~/.claude/commands/` (user-global). The session verbs land as native slash commands (`/lib-session-start`, `/lib-session-list`, `/lib-session-resume`, `/lib-session-checkpoint`, `/lib-session-pause`, `/lib-session-end`, `/lib-session-search`), plus the privacy toggle `/lib-toggle-private`. Each command is a thin prompt that tells the agent which MCP tool to call with which scoping.
   ```sh
   mkdir -p .claude/commands
   cp integrations/claude-code/commands/*.md .claude/commands/
   ```

4. **Install the automatic lifecycle hooks (recommended).** These start/resume a session on your first meaningful prompt, checkpoint on compaction and task completion, pause on session end, and enforce the privacy gate (`/lib-toggle-private` and off-record markers like "off the record"). Copy the hook script and merge the hook config into your settings:
   ```sh
   mkdir -p .claude/hooks/librarian
   cp integrations/claude-code/hooks/librarian/dispatch.sh .claude/hooks/librarian/
   chmod +x .claude/hooks/librarian/dispatch.sh
   # then merge integrations/claude-code/hooks/settings.example.json into .claude/settings.json
   ```
   The hooks require `the-librarian` and `librarian-claude-hook` (from `@librarian/lifecycle`) on `PATH`. Set `LIBRARIAN_AGENT_ID` (canonical agent id) and optionally `LIBRARIAN_PROJECT_KEY`. The privacy gate **never blocks your prompt** — it only suppresses the Librarian call when off-record — and if the helper isn't installed the hook is a silent no-op.

5. **Optionally use [`wrapper.sh`](./wrapper.sh)** to bracket `claude` invocations with `the-librarian sessions start` (on launch) and `pause` (on exit). The wrapper exports `LIBRARIAN_SESSION_ID` so child processes can record events against the right session. Use the wrapper *or* the hooks — the hooks are the richer, privacy-aware path.
   ```sh
   chmod +x integrations/claude-code/wrapper.sh
   integrations/claude-code/wrapper.sh --project the-librarian -- claude
   ```

6. **Run the healthcheck.** See [`healthcheck.md`](./healthcheck.md).

## Automatic lifecycle & privacy

The hooks installed in step 4 are thin shells around the `librarian-claude-hook` bin, which maps Claude Code hook events onto the shared lifecycle helper ([`integrations/shared/librarian-lifecycle`](../shared/librarian-lifecycle)):

| Claude event | Action |
|---|---|
| `UserPromptSubmit` | Privacy gate + start/resume a session (idempotent). |
| `PostCompact` | Checkpoint (high-value boundary). |
| `TaskCompleted` | Gated checkpoint. |
| `SessionEnd` | Pause (never end — process exit is rarely a coherent stop). |
| `SessionStart` / `Stop` | No-op (a session is created lazily on the first prompt). |

Privacy is local and fails closed: if the hook can't read/write its local state it makes no automatic Librarian call. Going private ends the attached public session with a neutral reason and suppresses further calls until you go public again. See [`docs/specs/harness-commands-and-lifecycle-spec.md`](../../docs/specs/harness-commands-and-lifecycle-spec.md).

## Native resume interaction

Claude Code has its own `--resume` mechanism for native session continuation. The Librarian's session layer is **additive**: it does not replace `--resume`, it complements it by providing a neutral, durable handover layer that any harness can read.

- Use Claude's `--resume` for in-session context continuation within Claude.
- Use `/lib:session resume <id>` (or `the-librarian sessions continue <id> --format claude`) when handing the work off to a different harness, or when you want to read the session from outside Claude.

## Native metadata capture

The wrapper reads whatever Claude Code exposes (env vars like `CLAUDE_SESSION_ID` when present, `--resume` target, cwd) and stores it as `source_ref` (in the `claude:session:{id}` form when available, falling back to `cwd:{path}`). Partial data is accepted gracefully — a session without a native Claude id still functions; it just can't round-trip through `--resume`.

## See also

- Canonical slash command contract: [`docs/slash-commands.md`](../../docs/slash-commands.md)
- Full session spec: [`specs/done/session-layer-and-harness-packages.md`](../../specs/done/session-layer-and-harness-packages.md)

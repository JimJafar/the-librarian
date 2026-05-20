# Claude Code slash command wiring

The canonical cross-harness contract uses `/lib:session <verb>` as the abstract surface (see [`docs/slash-commands.md`](../../docs/slash-commands.md)). Each harness implements it with whatever native pattern best fits — for Claude Code that's **one native slash command per verb**, shipped as markdown files under `commands/`.

## Native per-verb commands

Copy [`commands/`](./commands/) into your project's `.claude/commands/` (or `~/.claude/commands/` for user-global use):

```sh
mkdir -p .claude/commands
cp integrations/claude-code/commands/*.md .claude/commands/
```

You get 11 native Claude Code slash commands with autocomplete and zero parsing ambiguity:

| Slash command | MCP tool called | Notes |
|---|---|---|
| `/lib-session-start [title] [--private]` | `start_session` | Build `start_summary` from current visible context (file paths, recent edits, user prompt). Sensitivity check before common-visibility sessions. |
| `/lib-session-list` | `list_sessions` | Scope by current project (CLAUDE.md root) and `cwd`. |
| `/lib-session-resume <n|id>` | `continue_session` (default `attach:true`) | Pass `target_harness: "claude-code"`, `target_cwd: <project root>`, and `target_source_ref: claude:session:<id>` when `CLAUDE_SESSION_ID` is set. |
| `/lib-session-checkpoint` | `checkpoint_session` | Summarise work since last checkpoint or session start. |
| `/lib-session-pause` | `pause_session` | Use on process exit, harness backgrounding, or explicit user pause. |
| `/lib-session-end` | `end_session` | Return candidate durable memories — do not auto-promote. |
| `/lib-session-archive <n|id> [reason...]` | `archive_session` | Hidden from default lists. |
| `/lib-session-restore <n|id>` | `restore_session` | Owner-or-admin. |
| `/lib-session-delete <n|id> [reason...]` | `delete_session` | Owner-or-admin. Confirm before sending. |
| `/lib-session-search <query>` | `search_sessions` | Scope by current project. |
| `/lib-session-status` | `get_session` (+ `list_session_events`) | Currently attached session for this harness/cwd. |

## Why per-verb and not a single command?

Claude Code's custom-command system gives one prompt per markdown file with native autocompletion. Splitting per verb means:

- The user gets a real autocomplete list when they type `/lib-session-`.
- The agent never has to "recognise" the command from chat text — Claude Code dispatches it directly.
- Each command's prompt is tiny and focused (one verb, one tool, one set of defaults).

Hermes registers a single `/lib:session` command and parses the remainder because its slash system favours that pattern. OpenCode ships per-verb commands like Claude Code. The cross-harness contract is documented in [`docs/slash-commands.md`](../../docs/slash-commands.md); the MCP tool surface is identical either way.

## Numbered selection

Numbers from `/lib-session-list` are agent-side scratch within the current Claude conversation. **Every tool call must take the canonical `session_id`.** On `/compact` or a fresh window, re-run `/lib-session-list` to refresh the numbering.

## Sensitivity confirmation

Before a `common` session is started (and `--private` was not supplied), the agent must check the surrounding context (file contents, recent edits, user prompts) for sensitivity signals: identity claims, secrets, personal context, sensitive debugging. If signals are present, confirm with the user before calling `start_session`. (This logic lives in `commands/lib-session-start.md`.)

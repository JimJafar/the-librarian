# Claude Code slash command wiring

The canonical `/lib:session` contract lives in [`docs/slash-commands.md`](../../docs/slash-commands.md). This file documents Claude Code-specific wiring on top of it.

## Textual commands, not native slash commands

Claude Code's slash command system (`/help`, `/clear`, etc.) is reserved for harness-level CLI features. The `/lib:session` surface is **textual** — the agent recognises `/lib:session ...` in user input and routes to the corresponding MCP tool.

This avoids namespace collisions with Claude Code's own slash registration and keeps the contract uniform across harnesses.

## Subcommand mapping

| User typed | MCP tool called | Notes |
|---|---|---|
| `/lib:session start [title] [--private]` | `start_session` | Build `start_summary` from current visible context (file paths, recent edits, user prompt). |
| `/lib:session list` | `list_sessions` | Scope by current project (CLAUDE.md root) and `cwd` where possible. |
| `/lib:session resume <n|id>` | `continue_session` (default `attach:true`) | Pass `target_harness: "claude-code"`, `target_cwd: <project root>`, and `target_source_ref: claude:session:<id>` when `CLAUDE_SESSION_ID` is set. |
| `/lib:session checkpoint` | `checkpoint_session` | Summarise work since last checkpoint or session start. |
| `/lib:session pause` | `pause_session` | Use on process exit, harness backgrounding, or explicit user pause. |
| `/lib:session end` | `end_session` | Return candidate durable memories — do not auto-promote. |
| `/lib:session archive <n|id>` | `archive_session` | |
| `/lib:session restore <n|id>` | `restore_session` | Owner-or-admin. |
| `/lib:session delete <n|id>` | `delete_session` | Owner-or-admin. Confirm before sending. |
| `/lib:session search <query>` | `search_sessions` | |
| `/lib:session status` | `get_session` for the currently attached session | |

## Numbered selection

Numbers from `/lib:session list` are agent-side scratch within the current Claude conversation. **Every tool call must take the canonical `session_id`.** On `/compact` or a fresh window, re-run `/lib:session list` to refresh the numbering.

## Sensitivity confirmation

Before a `common` session is started (and `--private` was not supplied), the agent must check the surrounding context (file contents, recent edits, user prompts) for sensitivity signals: identity claims, secrets, personal context, sensitive debugging. If signals are present, confirm with the user before calling `start_session`.

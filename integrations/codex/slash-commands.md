# Codex slash command wiring

The canonical `/lib:session` contract lives in [`docs/slash-commands.md`](../../docs/slash-commands.md). This file documents Codex-specific wiring on top of it.

## Textual commands

`/lib:session` commands in Codex are **textual** — the agent recognises `/lib:session ...` in user input and routes to the corresponding MCP tool. This avoids registering a separate command surface and keeps the contract uniform across harnesses.

## Subcommand mapping

| User typed | MCP tool called | Notes |
|---|---|---|
| `/lib:session start [title] [--private]` | `start_session` | Build `start_summary` from the active file context and user prompt. |
| `/lib:session list` | `list_sessions` | Scope by current project (AGENTS.md root) and cwd. |
| `/lib:session resume <n|id>` | `continue_session` (default `attach:true`) | Pass `target_harness: "codex"`, `target_cwd: <project root>`, and `target_source_ref: codex:run:<run>:cwd:<path>` (or `cwd:<path>` fallback). |
| `/lib:session checkpoint` | `checkpoint_session` | |
| `/lib:session pause` | `pause_session` | |
| `/lib:session end` | `end_session` | Return candidate durable memories — do not auto-promote. |
| `/lib:session archive <n|id>` | `archive_session` | |
| `/lib:session restore <n|id>` | `restore_session` | Owner-or-admin. |
| `/lib:session delete <n|id>` | `delete_session` | Owner-or-admin. Confirm before sending. |
| `/lib:session search <query>` | `search_sessions` | |
| `/lib:session status` | `get_session` for the currently attached session | |

## Numbered selection

Numbers from `/lib:session list` are agent-side scratch within the current Codex conversation. **Every tool call must take the canonical `session_id`.** On compaction or a fresh window, re-run `/lib:session list` to refresh.

## Sensitivity confirmation

Before a `common` session is started (and `--private` was not supplied), check the surrounding context for sensitivity signals (identity, secrets, personal context, sensitive debugging). If signals are present, confirm with the user before calling `start_session`.

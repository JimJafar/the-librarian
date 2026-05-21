# OpenCode slash command wiring

The canonical cross-harness contract uses `/lib:session <verb>` as the abstract surface (see [`docs/slash-commands.md`](../../docs/slash-commands.md)). For OpenCode, that's implemented as **one native slash command per verb**, shipped as markdown files under `commands/`.

## Native per-verb commands

Copy [`commands/`](./commands/) into your project's `.opencode/commands/` (or `~/.config/opencode/commands/` for user-global use):

```sh
mkdir -p .opencode/commands
cp integrations/opencode/commands/*.md .opencode/commands/
```

You get 7 native OpenCode slash commands with autocomplete and zero parsing ambiguity:

| Slash command | MCP tool called | Notes |
|---|---|---|
| `/lib-session-start [title] [--private]` | `start_session` | Build `start_summary` from current visible context. Sensitivity check before common-visibility sessions. |
| `/lib-session-list [--include-ended]` | `list_sessions` | Scope by current project (AGENTS.md root) and `cwd`. Default scope `active + paused`; `--include-ended` (or legacy `--archived` / `--deleted`) adds `ended`. |
| `/lib-session-resume [<n|id>]` | `continue_session` (default `attach:true`) | Pass `target_harness: "opencode"`, `target_cwd: <project root>`, and `target_source_ref: opencode:project:<path>` (with `:session:${OPENCODE_SESSION_ID}` suffix when set). With no argument, the command does an inline list-and-select flow. Works on `ended` sessions (flips them back to `paused`). |
| `/lib-session-checkpoint` | `checkpoint_session` | Summarise work since last checkpoint or session start. |
| `/lib-session-pause` | `pause_session` | Use on harness backgrounding or explicit user pause. |
| `/lib-session-end` | `end_session` | Summary is optional — bare call is the abandonment path. Return candidate durable memories — do not auto-promote. |
| `/lib-session-search <query> [--include-ended]` | `search_sessions` | Scope by current project. Default scope `active + paused`; `--include-ended` (or legacy `--archived` / `--deleted`) adds `ended`. |

The retired verbs `archive`, `restore`, `delete`, and `status` were removed when the three-state session model landed: `end` covers archive/delete, `resume` covers restore, and `list` scoped to the current harness covers status.

## JSON-form alternative

If you prefer to keep commands in `opencode.jsonc` rather than markdown files, [`commands.example.json`](./commands.example.json) defines the same 7 verbs inline under the `command` key. The markdown form is recommended — it's modular, version-controllable per-file, and matches what we ship for Claude Code.

## Numbered selection

Numbers from `/lib-session-list` are agent-side scratch within the current OpenCode conversation. **Every tool call must take the canonical `session_id`.** Re-run list to refresh after compaction or a fresh window.

## Sensitivity confirmation

Before a `common` session is started (and `--private` was not supplied), check the surrounding context for sensitivity signals (identity, secrets, personal context, sensitive debugging). If signals are present, confirm with the user before calling `start_session`. (This logic lives in `commands/lib-session-start.md`.)

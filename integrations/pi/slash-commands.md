# Pi slash command wiring

The canonical `/lib:session` contract lives in [`docs/slash-commands.md`](../../docs/slash-commands.md). This file documents Pi-specific wiring on top of it.

## Textual commands only

Pi's runtime interface is currently an open question (see the package README). Until that's locked down, `/lib:session` commands are **textual** — the agent recognises the form in user input and routes to MCP tools (or to CLI calls via the wrapper, when MCP isn't reachable).

No native slash registration. This keeps the package portable across the various ways Pi might run.

## Subcommand mapping

Identical to the canonical contract; see [`docs/slash-commands.md`](../../docs/slash-commands.md).

| User typed | MCP tool called |
|---|---|
| `/lib:session start [title] [--private]` | `start_session` |
| `/lib:session list [--include-ended]` | `list_sessions` |
| `/lib:session resume [<n|id>]` | `continue_session` (default `attach:true`; inline list-and-select when no arg; works on ended sessions) |
| `/lib:session checkpoint` / `pause` / `end` | `checkpoint_session` / `pause_session` / `end_session` (`end`'s summary is optional) |
| `/lib:session search <query> [--include-ended]` | `search_sessions` |

The retired verbs `archive`, `restore`, `delete`, and `status` were removed when the three-state session model landed: `end` covers archive/delete, `resume` covers restore, and `list` scoped to the current harness covers status.

## Numbered selection

Numbers from `/lib:session list` are agent-side scratch within the current Pi conversation. **Every tool call must take the canonical `session_id`.** Re-run list to refresh after compaction or a fresh window.

## Sensitivity confirmation

Before a `common` session is started (and `--private` was not supplied), check the surrounding context for sensitivity signals (identity, secrets, personal context, sensitive debugging). If signals are present, confirm with the user before calling `start_session`.

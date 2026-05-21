# Hermes slash command wiring

The canonical `/lib:session` contract lives in [`docs/slash-commands.md`](../../docs/slash-commands.md). This file documents Hermes-specific wiring on top of it.

## Native command registration

Register **one** Hermes slash command: `/lib:session`. Hermes parses the remainder (`<subcommand> [args]`). Do not register each verb separately — multi-word command registration is not portable.

Example (pseudocode, adapt to Hermes's actual command registration):

```yaml
commands:
  - name: /lib:session
    description: Manage Librarian sessions (start/list/resume/checkpoint/pause/end/search)
    handler: librarianSessionHandler
    arg_schema: free-text  # parse the remainder
```

## Text fallback (skill / agent contexts)

In agent or skill contexts where Hermes only sees free-form user messages, the agent recognises `/lib:session ...` in chat text and routes to the same MCP tools. Both paths converge on the same MCP surface — there is no per-route divergence.

## Subcommand mapping

| User typed | MCP tool called | Notes |
|---|---|---|
| `/lib:session start [title] [--private]` | `start_session` | Build `start_summary` from current visible context. |
| `/lib:session list [--include-ended]` | `list_sessions` | Default scope: `active + paused`. Pass `--include-ended` (or legacy `--archived` / `--deleted`) to also include `ended`. |
| `/lib:session resume [<n|id>]` | `continue_session` (default `attach:true`) | Map number → canonical `session_id` from the last list response. With no argument, do the inline list-and-select flow: call `list_sessions`, render the numbered list, ask the user to pick. Works on `ended` sessions (flips them to `paused`). |
| `/lib:session checkpoint` | `checkpoint_session` | Pull summary from agent's pre-call deliberation. |
| `/lib:session pause` | `pause_session` | Same shape as checkpoint. |
| `/lib:session end` | `end_session` | Summary is optional — omit for the "I'm done with this session" abandonment path. Return candidate durable memories — do not auto-promote. |
| `/lib:session search <query> [--include-ended]` | `search_sessions` | Returns numbered matches. |

The retired verbs `archive`, `restore`, `delete`, and `status` were removed when the three-state session model landed:

- `archive` / `delete` → use `end`. Soft-state is soft-state; both intents already projected to the same hidden status, so they were collapsed.
- `restore` → use `resume`. Resume now works on `ended` sessions and flips them back to `paused`.
- `status` → use `list` scoped to the current harness / cwd, or `get_session` directly when an attached `session_id` is already known.

## Numbered selection

Numbers from `/lib:session list` are agent-side scratch within the current conversation. **Every tool call must take the canonical `session_id`.** On compaction or a fresh window, re-run `/lib:session list` to refresh.

## Sensitivity confirmation

Before a `common` session is started (and no `--private` was supplied), the agent must check the surrounding Discord context for sensitivity signals (see `AGENTS.append.md` § Visibility). If signals are present, confirm with the user inline before calling `start_session`.

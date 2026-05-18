# Canonical `lib:` Slash Command Contract

This document is the source of truth for the user-facing slash commands that drive Librarian sessions across all supported harnesses (Hermes, Claude Code, Codex, Pi, OpenCode). Per-harness integration packages (under `integrations/`) wire these up using whatever native command system the harness offers; agents that only see free-form text recognise the same surface and route to the corresponding MCP tools.

The full specification lives in `specs/session-layer-and-harness-packages.md` under "Slash Command UX". This file is the agent/skill-author reference.

## Parsing model

- The abstract contract surface is `/lib:session <verb>` — that's how the spec, tests, and tool descriptions refer to it.
- Each harness implements the surface with whatever native slash pattern best fits:
  - **Single-command-plus-parse** (one registration of `/lib:session`, parse the remainder) — recommended for Discord-style command systems where multi-word commands aren't portable. Used by **Hermes**.
  - **Per-verb native commands** (one slash command per verb, e.g. `/lib-session-start`) — recommended for systems with first-class custom-command directories and autocomplete. Used by **Claude Code** (see `integrations/claude-code/commands/`) and **OpenCode** (see `integrations/opencode/commands/`).
- The MCP tool surface (`start_session`, `list_sessions`, …) is the single source of truth — whichever slash pattern a harness uses, the tools called are the same.
- Per-verb naming conventions follow the harness — Claude Code uses hyphens (`/lib-session-start`) because its custom-command files are flat markdown; harnesses that support namespacing safely MAY use `:` or other separators.

## Numbered selection is agent-side scratch

`/lib:session list` returns numbered entries. Those numbers are a UX convenience the agent maintains within the current conversation. **Every MCP tool call MUST take the canonical `session_id`** (`ses_…`). On compaction or fresh window, re-run `/lib:session list` to refresh the numbering.

## Visibility default and the sensitivity check

Sessions default to `common` visibility because cross-agent sharing is the point of the layer. Before calling `/lib:session start` without `--private`, the agent MUST scan the surrounding context for sensitivity signals (identity content, secrets, personal context, sensitive debugging). If any are present, confirm with the user before starting a `common` session — or pass `--private`.

This is **agent policy**, not store enforcement. The store and MCP layer trust the visibility value the caller supplies.

## Commands

| Command | MCP tool | CLI equivalent |
|---|---|---|
| `/lib:session start [title] [--private]` | `start_session` | `the-librarian sessions start` |
| `/lib:session list` | `list_sessions` | `the-librarian sessions list` |
| `/lib:session resume <n|session_id>` | `continue_session` | `the-librarian sessions continue` |
| `/lib:session checkpoint` | `checkpoint_session` | `the-librarian sessions checkpoint` |
| `/lib:session pause` | `pause_session` | `the-librarian sessions pause` |
| `/lib:session end` | `end_session` | `the-librarian sessions end` |
| `/lib:session archive <n|session_id>` | `archive_session` | `the-librarian sessions archive` |
| `/lib:session restore <n|session_id>` | `restore_session` | `the-librarian sessions restore` |
| `/lib:session delete <n|session_id>` | `delete_session` | `the-librarian sessions delete` |
| `/lib:session search <query>` | `search_sessions` | `the-librarian sessions search` |
| `/lib:session status` | `get_session` for the currently attached session | `the-librarian sessions show` |

### `/lib:session start [title] [--private]`

1. Determine harness, source, cwd, agent_id, and project from the surrounding context.
2. Call `start_context` for durable memory context.
3. Decide visibility (`common` by default; `agent_private` if `--private` or sensitivity signals detected — confirm with the user when signals are present without `--private`).
4. Build a start summary from current visible context.
5. Call `start_session`.
6. Return the new `session_id`, visibility, and a one-paragraph baseline.

On a long-running Discord thread (or similar surface), this command defines the lower bound for future summaries. Do NOT summarise messages before the start boundary unless the user explicitly asks.

### `/lib:session list`

1. Call `list_sessions` scoped to current project/source where available.
2. Render numbered choices with status, title, project, harness, source, last activity, and next step.
3. Never auto-resume.

### `/lib:session resume <number|session_id>`

1. Resolve the numbered selection from the last list response (agent-side mapping) into a canonical `session_id`. If no list has been run in this conversation, instruct the user to run `/lib:session list` first or accept a literal `session_id`.
2. Call `continue_session` with the current harness as `target_harness` (and `target_source_ref`/`target_cwd` if available). `attach: true` is the default — the single call both fetches the handover and records the move.
3. Inject or display the handover package according to harness capabilities.

### `/lib:session checkpoint`

1. Summarise work since session start or the previous checkpoint.
2. Record decisions, commands, files touched, open questions, and next steps.
3. Call `checkpoint_session`.
4. Keep the session active.

### `/lib:session pause`

1. Produce a pause summary and next steps.
2. Call `pause_session`.
3. Leave the session available in normal resume lists.

### `/lib:session end`

1. Produce a final summary from start summary, checkpoints, and current visible context.
2. Call `end_session`.
3. Return candidate durable memories — do **not** auto-promote them. Use `promote_session_fact` only with explicit user direction.
4. Mark the session ended.

### `/lib:session archive <number|session_id>`

1. Resolve session.
2. Call `archive_session`.
3. Exclude from normal session lists. Searchable via `include_archived`.

### `/lib:session restore <number|session_id>`

1. Resolve session.
2. Call `restore_session`. The session returns to its `prior_status` (or `paused` if `prior_status` is missing).
3. Re-include in normal session lists.

### `/lib:session delete <number|session_id>`

1. Resolve session.
2. Ask for confirmation where the harness supports interactive confirmation.
3. Call `delete_session`. Owner-or-admin only — the store will reject delete attempts by other agents and surface a clear error.
4. Exclude from normal session lists and search unless `include_deleted: true` and the caller is admin.

### `/lib:session search <query>`

1. Call `search_sessions`.
2. Return numbered matches.
3. Allow follow-up `/lib:session resume <number>`.

### `/lib:session status`

1. Look up the Librarian session attached to the current harness/source.
2. Show its recent checkpoints, current `rolling_summary`, and next steps.

## Boundaries

- Session history is **evidence**, not durable memory. Promote selectively via `/lib:session end` candidates or `promote_session_fact`.
- Lifecycle transitions are always explicit. There is no automatic idle-pause; an active session with no recent events stays active until something — agent, user, or operator — pauses or ends it.
- A Discord thread, terminal directory, or Claude native session is a **container**, not a session. Multiple Librarian sessions can attach to the same source over time.

# Spec: Cross-Harness Session Layer and Harness Setup Packages

## Status

Implemented 2026-05-21; partially superseded. This was the original contract that drove the cross-harness session layer + the five harness setup packages — that work shipped. The body below is preserved as historical record and is **not the current contract** for the parts noted here; read the superseding specs for current state.

**Superseded in part by:**

- [`specs/done/session-simplification.md`](./session-simplification.md) (S1.1–S1.3, PRs #49–#51) — collapses the status model to three states (`active | paused | ended`), removes `archive_session` / `restore_session` / `delete_session` MCP tools + the four corresponding slash verbs (`/lib:session archive|restore|delete|status`) + the CLI verbs, makes `end_session` summary optional, allows `continue_session` to work on ended sessions. Affects: §Objective, §Data Model "Session Fields" `status` enum + `prior_status`, §Session Status (whole subsection), §Status Transitions (whole table), §Canonical Event Types (state-transition entries), §MCP Tool Surface (the three retired tools), §`list_sessions` (default scope + `include_*` flags), §`end_session` (required summary), §CLI Surface (three retired commands), §Slash Command UX (four retired verbs), §Decisions Recorded #4 / #5, §Acceptance Criteria.
- [`specs/done/dashboard-redesign.md`](./dashboard-redesign.md) (D1.0–D1.5, PRs #52–#57) — replaces the dashboard described in §Dashboard Requirements with the editorial design (Memories / Sessions / Recall + cmd-K palette + `?` shortcuts overlay). The list/detail/search/promote functionality is preserved; the surfaces and visual direction are different.
- [`specs/done/maintainability-overhaul.md`](./maintainability-overhaul.md) + its `-plan.md` / `-tasks.md` companions (30 PRs across T1–T9) — moves the codebase from `src/cli.js` + `src/store.js` to a monorepo under `packages/`. Affects all file-path references in this spec (`src/store.js:101`, `node src/cli.js`, etc.); current paths live under `packages/core/src/store/*.ts` and `packages/cli/src/cli.ts`.
- [`specs/session-storage-rearchitecture.md`](../session-storage-rearchitecture.md) (R1–R4, **drafted, not yet implemented**) — moves session state from JSONL-canonical to SQLite-canonical with a new `session_events.jsonl` for timeline events only. When R lands it will further supersede: §Principle 7 ("event-sourced canonical data"), §Data Model "Session Fields" framing (becomes authoritative, gains `state_version`), §Storage (entire section — file names, rebuild story, rationale), §Canonical Event Types (state-transition events leave the emit path), §Decisions Recorded #2 (separate JSONL ledger), §Implementation Plan Phase 1 (rebuild story), §Acceptance Criteria #1 + #2.

**Not superseded — still authoritative below:**

- The objective (cross-harness session continuity layer).
- Principles 1–6, 8, 9 (Principle 7 will need amending when R lands).
- Topology (single canonical Librarian over HTTP MCP).
- Terminology (harness, source, `source_ref` grammar, librarian session, checkpoint, handover).
- Capture mode model (`off | summary | log`).
- The non-retired MCP tools: `start_session`, `list_sessions`, `continue_session`, `attach_session`, `record_session_event`, `checkpoint_session`, `pause_session`, `end_session`, `search_sessions`, `get_session`, `list_session_events`, `promote_session_fact`.
- Handover Package Format.
- Security and Privacy (redaction list, visibility model, protected memory routing).
- Harness Setup Packages structure (`integrations/<harness>/` conventions, `AGENTS.append.md` vs `AGENTS.md`, wrapper.sh, healthcheck.md).
- Long-Running Discord Thread Behaviour (agent policy).
- Most Decisions Recorded entries other than #2, #4, #5.

Originally drafted 2026-05-12. Implementation drove the work through T3.x of the maintainability overhaul.

---

## Objective

The Librarian should become the shared session-continuity layer for Jim's agent work across harnesses: Hermes, Claude Code, Codex, Pi, OpenCode, and future runtimes.

Today each harness has its own partial resume mechanism. Claude Code has native resume flags. Hermes can continue in an existing Discord thread. Other harnesses have their own process, terminal, or conversation state. This makes handover manual and unreliable, especially when Jim has several agents working concurrently.

This feature adds first-class sessions to The Librarian and ships harness setup packages that make session start, checkpoint, resume, archive, delete, and end workflows consistent everywhere. The Librarian does not replace native harness resume. It provides a neutral, durable, searchable handover layer that any harness can use.

Success means Jim can run or ask for a `lib:` session command in any supported harness, see a clear list of resumable sessions, select the right one explicitly, and receive a context package suitable for continuing work in that harness.

## Principles

1. **List-and-select, not “last session”.** Jim frequently runs multiple agents concurrently. The system must not assume the most recent session is the one to resume.
2. **Sessions are not durable memories.** Session history is evidence and handover context. Durable memory remains curated through `remember`, `propose_memory`, and review workflows.
3. **One canonical session model, many harness adapters.** Claude, Codex, Hermes, Pi, and OpenCode can keep their native behaviours, but all map to The Librarian's session model.
4. **Explicit lifecycle beats guessing.** Agents can suggest checkpoints and summaries, but slash commands or harness hooks should drive authoritative start/pause/end/archive/delete transitions.
5. **Multiple active sessions are normal.** `active` is not singleton. Session lists must show enough metadata to choose safely.
6. **Thread/container is not session.** A Discord thread, terminal directory, or Claude native session can contain or attach to multiple Librarian sessions over time.
7. **Canonical data remains event-sourced.** Session state is derived from append-only JSONL events, just like existing memories.
8. **Safe by default.** Raw transcript capture is optional, redacted, and excluded from durable recall by default.
9. **Shared by default, private on signal.** Sessions default to `common` visibility because cross-agent sharing is the entire point of the layer. The agent must detect sensitivity signals (identity, secrets, personal context, sensitive debugging) and confirm with the user before starting a `common` session whose content looks private.

## Non-goals

- Do not replace Claude Code's native resume, Hermes Discord thread continuation, or other harness-native mechanisms.
- Do not summarise an entire long-running Discord thread by default.
- Do not auto-promote session details into durable memory.
- Do not require vector search for MVP.
- Do not require every harness to expose the same native capabilities.
- Do not make `/session` or similarly generic slash commands; use the `lib:` prefix to avoid conflicts.

## Topology

The session layer assumes a **single canonical Librarian instance** that every harness connects to over HTTP MCP. This is the precondition for "create in Hermes, resume in Codex" to work — Hermes on its server, Claude Code on the laptop, Codex/OpenCode locally, and Pi all read and write the same `events.jsonl`/`sessions.jsonl` ledgers and the same SQLite projection.

Implications:

- The canonical instance is the one already running for Hermes (or its successor); local-only Librarian installs are not supported for session continuity.
- All session MCP tools require network reachability to that instance. Wrappers must handle transient unreachability via the fallback capture mechanism in [proposals/safe-fallback-capture.md](../proposals/safe-fallback-capture.md).
- Durable memory continues to use the same shared instance, unchanged from today.
- A future option for local Librarian installs with sync is out of scope.

## Existing Context

The Librarian currently provides:

- canonical `events.jsonl` event ledger,
- generated SQLite + FTS5 index,
- generated Markdown snapshot,
- MCP tools for durable memory lifecycle,
- protected `identity` and `relationship` categories,
- `common` versus `agent_private` visibility,
- admin-only approval/deletion/conflict-resolution tools,
- clean prose agent-facing context output.

This spec extends that architecture without weakening the governed memory model.

## Terminology

### Harness

The runtime or tool where agent work happens.

Examples: `hermes`, `claude-code`, `codex`, `pi`, `opencode`.

### Source

The concrete location or native session reference in a harness, expressed as a `source_ref` string.

`source_ref` uses a colon-separated URI-style grammar with documented per-harness prefixes:

```text
discord:channel:{channel_id}:thread:{thread_id}
cwd:{absolute_path}
claude:session:{session_id}
codex:run:{run_id}:cwd:{absolute_path}
opencode:project:{absolute_path}
pi:device:{device_id}:session:{session_id}
```

Harnesses use the most specific form they can produce. A harness that cannot produce a native session id falls back to `cwd:{abs_path}` or its container reference (e.g. `discord:channel:{cid}` without a thread). Each harness package documents which form it emits.

### Librarian Session

A user/task-bounded unit of work tracked by The Librarian. It can be created in one harness and resumed in another.

### Checkpoint

A structured mid-session summary that preserves progress before context loss, compaction, harness exit, or a work break.

### Handover

A compact context package generated from session data for continuing work in any harness.

## Data Model

### Session Fields

Derived SQLite projection table: `sessions`.

```text
sessions
- id text primary key                       -- "ses_" + 16 hex chars (makeId)
- title text not null                       -- server-generated placeholder if not supplied
- project_key text
- status text not null                      -- active | paused | ended | archived | deleted
- prior_status text                         -- last non-archived/non-deleted status, used by restore
- visibility text not null                  -- common | agent_private
- created_by_agent_id text
- current_agent_id text
- created_in_harness text
- current_harness text                      -- singular; updated by attach. History in events.
- source_ref text                           -- singular; updated by attach. History in events.
- cwd text
- start_summary text
- rolling_summary text                      -- overwritten by checkpoint and pause
- end_summary text                          -- written by end_session; rolling_summary frozen afterwards
- next_steps_json text
- tags_json text
- capture_mode text not null                -- off | summary | log
- started_at text not null
- updated_at text not null                  -- bumped by any session event or status change
- last_activity_at text not null
- paused_at text
- ended_at text
- archived_at text
- deleted_at text
- metadata_json text
```

If `title` is not supplied at `start_session`, the server generates `"{project_key or current_harness} session @ {iso_timestamp}"`.

### Session Event Fields

Derived SQLite projection table: `session_events`.

```text
session_events
- id text primary key
- session_id text not null
- type text not null
- agent_id text
- harness text
- source_ref text
- summary text not null
- payload_json text
- created_at text not null
```

FTS table:

```text
session_events_fts
- event_id
- session_id
- summary
- payload_text
```

### Session Status

```text
active
```

Work is believed to be in progress. Multiple sessions may be active at the same time.

```text
paused
```

Work stopped or the harness exited, but the task may resume later. Default state for process exit without explicit final summary.

```text
ended
```

Work reached a coherent stopping point and has an end summary.

```text
archived
```

Hidden from normal resume lists but retained for search and audit.

```text
deleted
```

Soft-deleted. Excluded by default. Physical purge is a future/admin-only operation.

### Status Transitions

| From → To  | active | paused | ended | archived | deleted |
|------------|--------|--------|-------|----------|---------|
| active     | —      | pause  | end   | archive  | delete  |
| paused     | resume | —      | end   | archive  | delete  |
| ended      | ✗      | ✗      | —     | archive  | delete  |
| archived   | restore* | restore* | restore* | — | delete |
| deleted    | restore* | restore* | restore* | restore* | — |

Notes:

- `resume` is implicit: any tool that records activity on a `paused` session transitions it back to `active` and clears `paused_at`. There is no dedicated `resume_session` tool.
- `ended` is terminal in the forward direction. To pick the work back up, start a new session that references the ended one via `metadata_json.continues_from`.
- `restore*` returns the session to `prior_status` (the last non-archived/non-deleted status recorded at archive/delete time). If `prior_status` is missing for any reason, restore returns to `paused`.
- All transitions append a corresponding ledger event (`session.paused`, `session.ended`, `session.archived`, `session.restored`, `session.deleted`) and bump `updated_at`.

### Capture Mode

```text
off
```

No transcript/log capture. Only explicit events are stored.

```text
summary
```

Store agent-supplied structured summaries, checkpoints, commands, file lists, and decisions. Recommended default.

```text
log
```

Store raw or near-raw transcript/log fragments after redaction. Off by default and excluded from durable memory recall. **This spec does not define a log-ingestion MCP tool.** Harness wrappers supply log fragments via the mechanism in [proposals/safe-fallback-capture.md](../proposals/safe-fallback-capture.md). Setting `capture_mode: log` on a session is a declaration of intent; the actual writing path lives in that proposal.

## Canonical Event Types

Session state must be reconstructable from JSONL events. Session events live in their own ledger file (`sessions.jsonl`) separate from `events.jsonl`; see [Storage](#storage).

### MVP ledger event types

```text
session.started
session.attached_to_harness
session.event_recorded
session.checkpointed
session.paused
session.ended
session.archived
session.restored
session.deleted
session.promoted_to_memory
```

### Non-MVP (deferred)

```text
session.split
session.merged
session.purged
```

### Two-layer event model

There are two distinct vocabularies and they should not be confused:

1. **Ledger event types** (above). These are the persistent JSONL events that the projection reduces over. They drive session state and lifecycle.
2. **Payload event categories** (used inside `record_session_event`): `message`, `command`, `file`, `error`, `decision`, `question`, `checkpoint`, `handover`, `note`. These describe the *kind* of evidence being recorded.

Mapping:

| MCP call                | Ledger event                  | `payload.type`           |
|-------------------------|-------------------------------|--------------------------|
| `start_session`         | `session.started`             | —                        |
| `attach_session` / `continue_session` with `attach: true` | `session.attached_to_harness` | — |
| `record_session_event`  | `session.event_recorded`      | one of the categories    |
| `checkpoint_session`    | `session.checkpointed`        | —                        |
| `pause_session`         | `session.paused`              | —                        |
| `end_session`           | `session.ended`               | —                        |
| `archive_session`       | `session.archived`            | —                        |
| `restore_session`       | `session.restored`            | —                        |
| `delete_session`        | `session.deleted`             | —                        |
| `promote_session_fact`  | `session.promoted_to_memory`  | —                        |

Lifecycle changes get their own ledger types because they affect session state; general-purpose evidence flows through `session.event_recorded` with a typed payload.

## Storage

Session events live in `{data_dir}/sessions.jsonl`, separate from the existing `{data_dir}/events.jsonl` used for memory events. Rationale:

- Session events are inherently higher-volume than memory events (every checkpoint, decision, command, file, error per active session).
- The existing `LibrarianStore` rebuilds the full memory projection on every `appendEvent` ([src/store.js:101](../src/store.js#L101)). Folding session events into the same path would make memory writes slow as session traffic grows.
- Separating ledgers lets session projection use **incremental insert** (one row per appended event) without touching the memory rebuild path.

Projection tables (`sessions`, `session_events`, `session_events_fts`) live in the existing `librarian.sqlite` database alongside `memories`. A full rebuild command (`npm run rebuild`) replays both ledgers from scratch for recovery; normal appends are incremental.

## MCP Tool Surface

### `start_session`

Creates a new Librarian session and records a start summary.

Input:

```json
{
  "agent_id": "bede",
  "title": "Cross-harness session recall design",
  "project_key": "the-librarian",
  "visibility": "common",
  "harness": "hermes",
  "source_ref": "discord:channel:1490347928517345432:thread:1504245255925665854",
  "cwd": "/home/jim/the-librarian",
  "capture_mode": "summary",
  "start_summary": "Jim wants a cross-harness session recall layer...",
  "tags": ["sessions", "librarian"]
}
```

`title` is optional; if omitted the server generates `"{project_key or harness} session @ {iso_timestamp}"`. `visibility` defaults to `common`; see [Principle 9](#principles) for when an agent must confirm a private session instead.

Output includes the session id and a short confirmation suitable for a human.

### `list_sessions`

Returns selectable sessions. This is the default resume entry point.

Input:

```json
{
  "agent_id": "bede",
  "project_key": "the-librarian",
  "status": ["active", "paused", "ended"],
  "include_archived": false,
  "include_deleted": false,
  "limit": 10
}
```

Omit `harness` (or any other filter) to match all values. Visibility filtering is automatic: callers see `common` sessions plus their own `agent_private` sessions.

Ranking is **lexicographic** by the following keys, in order:

1. status priority: `active` (0) > `paused` (1) > `ended` (2);
2. project match: same `project_key` as caller (0) > other (1);
3. source match: same `source_ref` or `cwd` as caller (0) > other (1);
4. has `next_steps`: non-empty (0) > empty (1);
5. recency: `last_activity_at` descending.

The tool MUST NOT auto-select a session. Numbered display indices in the response are advisory and used by the slash UX; every subsequent tool call MUST pass the canonical `session_id`.

### `continue_session`

Generates a cross-harness handover package and, by default, attaches the session to the target harness in one call.

Input:

```json
{
  "agent_id": "bede",
  "session_id": "ses_...",
  "target_harness": "claude-code",
  "target_source_ref": "claude:session:abc123",
  "target_cwd": "/home/jim/the-librarian",
  "attach": true,
  "format": "prose"
}
```

Behaviour:

- If `attach: true` (default) and `target_harness` differs from `current_harness` (or `target_source_ref` differs from `current_source_ref`), `current_harness`, `current_agent_id`, `source_ref`, and `cwd` are overwritten and a `session.attached_to_harness` event is appended.
- If `attach: false`, the handover is read-only — useful for previewing a session before deciding to resume.
- `format` selects a renderer: `prose | markdown | claude | codex | opencode | hermes | pi`.

Output includes:

- title, project, status, visibility,
- original harness/source,
- current harness/source,
- start summary,
- rolling summary,
- end summary if any,
- decisions, commands, files touched, open questions, next steps,
- harness-specific resume notes.

### `attach_session`

Low-level helper exposed for harnesses that need to record attachment without generating a handover (e.g. a wrapper that has the handover cached). Same effect on session fields as `continue_session` with `attach: true`. Most callers should use `continue_session` instead.

Input:

```json
{
  "agent_id": "bede",
  "session_id": "ses_...",
  "harness": "codex",
  "source_ref": "codex:run:r_42:cwd:/home/jim/the-librarian",
  "cwd": "/home/jim/the-librarian"
}
```

### `record_session_event`

Records structured evidence within a session. Each call appends one `session.event_recorded` ledger event whose `payload.type` is the supplied category.

Input:

```json
{
  "agent_id": "bede",
  "session_id": "ses_...",
  "harness": "hermes",
  "type": "decision",
  "summary": "Use list-and-select session resume rather than latest-session inference.",
  "payload": {
    "confidence": "confirmed"
  }
}
```

Allowed `type` values:

```text
message | command | file | error | decision | question | checkpoint | handover | note
```

Any call bumps `last_activity_at` and `updated_at`, and transitions a `paused` session back to `active` (implicit resume).

### `checkpoint_session`

Updates rolling session state. Overwrites `rolling_summary` with the supplied summary.

Input:

```json
{
  "agent_id": "bede",
  "session_id": "ses_...",
  "summary": "We formalised the session model and slash-command UX.",
  "decisions": ["Use lib: prefix for session commands."],
  "files_touched": ["specs/session-layer-and-harness-packages.md"],
  "commands_run": [],
  "open_questions": [],
  "next_steps": ["Implement session event projection."]
}
```

Appends a `session.checkpointed` ledger event and bumps `updated_at`. Keeps the session `active`.

### `pause_session`

Marks a session paused, overwrites `rolling_summary` with the supplied pause summary, and sets `paused_at`. Harness process exit should generally pause, not end.

Input: same shape as `checkpoint_session`; all fields except `session_id` and `summary` optional.

### `end_session`

Marks a session ended. Writes `end_summary`; freezes `rolling_summary` at its current value (the spec convention is that `rolling_summary` continues to reflect the final pre-end checkpoint).

Input should include:

- summary,
- decisions,
- files touched,
- commands run,
- unresolved questions,
- next steps,
- candidate durable memories.

The tool MUST NOT automatically save candidate durable memories. It may return suggested `remember`, `propose_memory`, or `promote_session_fact` calls.

### `archive_session`

Hides a session from normal resume lists while retaining searchability via `include_archived: true`. Records `prior_status` so `restore_session` can return to the right state.

Input:

```json
{
  "agent_id": "bede",
  "session_id": "ses_...",
  "reason": "throwaway spike"
}
```

### `restore_session`

Restores an archived or soft-deleted session to `prior_status` (falling back to `paused` if `prior_status` is missing). Owner can restore own sessions; admin can restore any.

Input:

```json
{
  "agent_id": "bede",
  "session_id": "ses_..."
}
```

### `delete_session`

Soft-deletes a session. **Permissions:** the session owner (`created_by_agent_id == agent_id`) may delete their own sessions; deleting sessions owned by another agent requires admin role. Physical purge is out of scope for MVP and remains admin-only.

Input:

```json
{
  "agent_id": "bede",
  "session_id": "ses_...",
  "reason": "test session"
}
```

### `search_sessions`

Searches session summaries and events, separate from durable memory recall. Archived sessions are excluded by default; pass `include_archived: true` to include them. Deleted sessions are always excluded unless an admin caller passes `include_deleted: true`.

Input:

```json
{
  "agent_id": "bede",
  "query": "Shokunin BM25 session recall",
  "project_key": "the-librarian",
  "include_archived": false,
  "include_deleted": false,
  "limit": 5
}
```

### `get_session`

Returns the full session row plus per-event counts. Used by dashboards and by agents that want to inspect a session without generating a handover.

Input:

```json
{
  "agent_id": "bede",
  "session_id": "ses_..."
}
```

### `list_session_events`

Returns the event stream for a session with pagination.

Input:

```json
{
  "agent_id": "bede",
  "session_id": "ses_...",
  "type": "decision",
  "limit": 50,
  "offset": 0
}
```

### `promote_session_fact`

Creates a durable memory (or proposal, for protected categories) from selected session evidence. Appends a `session.promoted_to_memory` ledger event that links the resulting memory id back to the source session and (optionally) the specific session event.

Input:

```json
{
  "agent_id": "bede",
  "session_id": "ses_...",
  "session_event_id": "evt_...",
  "memory": {
    "title": "Default to common visibility for sessions",
    "body": "...",
    "category": "tools",
    "visibility": "common",
    "scope": "tool",
    "project_key": "the-librarian",
    "priority": "high",
    "confidence": "strong",
    "tags": ["sessions", "policy"]
  }
}
```

Behaviour:

- `memory` accepts the same shape as `remember` / `propose_memory`.
- If `memory.category` is a protected category (`identity`, `relationship`), the call routes through the proposal flow regardless of caller role; otherwise it creates an active memory directly.
- `session_event_id` is optional and stored on the resulting memory's provenance for traceability.
- Returns the created/proposed memory.

## CLI Surface

Add a `sessions` namespace to the existing CLI. The current [src/cli.js](../src/cli.js) is a flat command parser supporting only `rebuild` and `seed`; introducing `sessions <subcommand>` requires a small subcommand router. That refactor is called out as a Phase 3 prerequisite.

Commands:

```sh
the-librarian sessions start --title "..." --project the-librarian --harness codex --cwd "$PWD" [--private]
the-librarian sessions list --project the-librarian
the-librarian sessions continue ses_123 --format prose [--no-attach]
the-librarian sessions attach ses_123 --harness claude-code --cwd "$PWD"
the-librarian sessions checkpoint ses_123 --summary-file checkpoint.md
the-librarian sessions pause ses_123 --summary-file pause.md
the-librarian sessions end ses_123 --summary-file end.md
the-librarian sessions archive ses_123 --reason "throwaway spike"
the-librarian sessions restore ses_123
the-librarian sessions delete ses_123 --reason "test session"
the-librarian sessions search "BM25 recall" --project the-librarian
the-librarian sessions show ses_123
the-librarian sessions events ses_123 --type decision --limit 50
```

The CLI should support machine-readable output:

```sh
--json
```

And harness-oriented output:

```sh
--format prose|markdown|claude|codex|opencode|hermes|pi
```

## Slash Command UX

All user-facing slash commands must use the `lib:` prefix to avoid conflicts with other skills or harness command systems.

**Parsing model:** the first token (`/lib:session`) is the command; everything after the first whitespace is subcommand + args. Harness slash registrations should register `/lib:session` (single command) and parse the remainder, not register each verb as a separate command. The reasoning: most slash systems treat the first token as the command name, and multi-word command registration is not portable across Discord/Claude/Codex/OpenCode.

**Numbered selection:** the number returned by `/lib:session list` is agent-side scratch only. Tool calls always take a canonical `session_id`. The agent is responsible for mapping numbers→ids within the conversation; on compaction or fresh window, run `/lib:session list` again.

Canonical commands:

```text
/lib:session start [title] [--private]
/lib:session list
/lib:session resume <number|session_id>
/lib:session checkpoint
/lib:session pause
/lib:session end
/lib:session archive <number|session_id>
/lib:session restore <number|session_id>
/lib:session delete <number|session_id>
/lib:session search <query>
/lib:session status
```

Aliases may be added only if the harness supports namespacing safely:

```text
/lib:start
/lib:list
/lib:resume
/lib:checkpoint
/lib:pause
/lib:end
/lib:archive
/lib:restore
/lib:delete
/lib:search
/lib:status
```

The long form is canonical for docs and tests.

### `/lib:session start [title] [--private]`

Expected behaviour:

1. Determine harness, source, cwd, agent id, and project if available.
2. Call `start_context` for durable memory context.
3. Decide visibility:
   - default is `common`;
   - if `--private` is supplied, use `agent_private`;
   - if the surrounding context contains sensitivity signals (identity content, secrets, personal context, sensitive debugging) and `--private` is NOT supplied, confirm with the user before starting (this is the operationalisation of [Principle 9](#principles)).
4. Create a start summary from current visible context plus selected prior sessions if any.
5. Call `start_session`.
6. Return the session id, visibility, and a one-paragraph baseline.

If the surface is a long-running Discord thread, this command defines the lower bound for future summary. The agent should not later summarise the whole historical thread unless explicitly asked and technically able.

### `/lib:session list`

Expected behaviour:

1. Call `list_sessions` scoped to current project/source where possible.
2. Return numbered choices.
3. Include status, title, project, harness, source, last activity, and next step.
4. Do not auto-resume.

### `/lib:session resume <number|session_id>`

Expected behaviour:

1. Resolve the numbered selection from the last list response (agent-side mapping) into a `session_id`. If no list has been run in this conversation, instruct the user to run `/lib:session list` first or accept a literal `session_id`.
2. Call `continue_session` with the current harness as `target_harness` (and `target_source_ref`, `target_cwd` if available). `attach: true` is the default, so this single call both fetches the handover and records the move.
3. Inject or display the handover package according to harness capabilities.

### `/lib:session checkpoint`

Expected behaviour:

1. Summarise work since session start or previous checkpoint.
2. Record decisions, commands, files, questions, and next steps.
3. Call `checkpoint_session`.
4. Keep the session active.

### `/lib:session pause`

Expected behaviour:

1. Produce a pause summary and next steps.
2. Call `pause_session`.
3. Leave the session available in normal resume lists.

### `/lib:session end`

Expected behaviour:

1. Produce a final summary from start summary, checkpoints, and current visible context.
2. Call `end_session`.
3. Return candidate durable memories but do not auto-promote them.
4. Mark the session ended.

### `/lib:session archive <number|session_id>`

Expected behaviour:

1. Resolve session.
2. Call `archive_session`.
3. Exclude from normal session lists.

### `/lib:session restore <number|session_id>`

Expected behaviour:

1. Resolve session.
2. Call `restore_session`. The session returns to its `prior_status` (or `paused` if `prior_status` is missing).
3. Re-include in normal session lists.

### `/lib:session delete <number|session_id>`

Expected behaviour:

1. Resolve session.
2. Ask for confirmation where the harness supports interactive confirmation.
3. Call `delete_session` for soft deletion. The server enforces ownership: an agent may delete only sessions it created; deleting another agent's session requires admin role and surfaces a clear error otherwise.
4. Exclude from normal session lists and search unless requested.

### `/lib:session search <query>`

Expected behaviour:

1. Call `search_sessions`.
2. Return numbered matches.
3. Allow follow-up `/lib:session resume <number>`.

### `/lib:session status`

Expected behaviour:

Show the current attached Librarian session for this harness/source, if any, plus recent checkpoints and next steps.

## Long-Running Discord Thread Behaviour

A Discord thread is a source/container, not a session. The rules below are **agent policy**, not store enforcement — they belong in `skills/use-the-librarian/SKILL.md` and similar harness skill instructions. The store has no way to enforce thread-level summary boundaries.

Agent policy:

1. `/lib:session start` establishes the session boundary.
2. `/lib:session checkpoint` summarises from the previous checkpoint or session start.
3. `/lib:session end` summarises from `start_summary + checkpoints + current visible context`.
4. Do not summarise messages before session start unless Jim explicitly requests it.
5. If no session exists and Jim asks for a summary, summarise only visible/current context and recommend starting a session baseline.

This is necessary because long threads can contain several unrelated sessions, and some harnesses cannot read full thread history.

## Harness Setup Packages

Add an `integrations/` directory containing installable/copyable packages for supported harnesses.

```text
integrations/
  README.md
  hermes/
    README.md
    AGENTS.append.md
    slash-commands.md
    config.example.yaml
    healthcheck.md
  claude-code/
    README.md
    CLAUDE.md
    slash-commands.md
    mcp.example.json
    wrapper.sh
    healthcheck.md
  codex/
    README.md
    AGENTS.md
    slash-commands.md
    mcp.example.json
    wrapper.sh
    healthcheck.md
  pi/
    README.md
    AGENTS.md
    slash-commands.md
    config.example.yaml
    wrapper.sh
    healthcheck.md
  opencode/
    README.md
    AGENTS.md
    slash-commands.md
    opencode.example.json
    commands.example.json
    wrapper.sh
    healthcheck.md
```

**File conventions:**

- `AGENTS.md` and `CLAUDE.md` are standalone agent instructions for harnesses where the user typically doesn't have a pre-existing file of that name.
- `AGENTS.append.md` is a snippet meant to be **concatenated** onto a host repository's existing `AGENTS.md` (e.g. Hermes's own `AGENTS.md`). The package README explains how to merge it.
- `wrapper.sh` is an executable shim that calls the harness binary while bracketing it with `the-librarian sessions start`/`pause` calls and setting `LIBRARIAN_SESSION_ID` in the environment.
- `healthcheck.md` documents the per-harness end-to-end smoke test.

Each package must include:

- MCP configuration example,
- exact install/setup steps,
- the `lib:` slash-command contract,
- how to start/list/resume/checkpoint/pause/end/archive/delete sessions,
- how to run a healthcheck,
- how to distinguish durable memory from session history,
- how to avoid saving secrets,
- examples of good handover summaries,
- examples of bad durable memories.

### Hermes Package

Primary surfaces:

- Discord threads,
- Hermes Agent sessions,
- Hermes skills,
- Hermes-native slash command wiring (where supported).

Requirements:

- Load or reference `skills/use-the-librarian/SKILL.md`.
- **Slash handling: native where Hermes supports it, text fallback elsewhere.** Wire `/lib:session` as a native Hermes command in surfaces that have a command system (autocomplete, structured args). In agent/skill contexts that only see free-form user messages, the agent recognises `/lib:session ...` in text and routes to the same MCP tools. Both paths converge on the same MCP surface.
- Store source refs as Discord channel/thread identifiers where available.
- Default capture mode: `summary`.
- For long threads, require `/lib:session start` baseline before reliable end summaries.

Example source ref:

```text
discord:channel:1490347928517345432:thread:1504245255925665854
```

### Claude Code Package

Primary surfaces:

- `CLAUDE.md`,
- MCP configuration,
- optional wrapper script around `claude`,
- native resume with Claude's own session mechanism where available.

Requirements:

- Include instructions that `lib:` commands are textual commands handled by the agent, not necessarily native Claude slash commands unless configured.
- Wrapper should call `the-librarian sessions start` on new work and `pause` on process exit where possible.
- `continue_session --format claude` should generate a Claude-friendly handover block.
- **Native metadata capture is best-effort, harness-dependent.** The wrapper reads whatever Claude Code exposes (env vars like `CLAUDE_SESSION_ID` if present, `--resume` target, cwd) and stores it in `source_ref` (using the `claude:session:{id}` form when available, falling back to `cwd:{path}`) and `metadata_json`. Partial data is accepted gracefully — a session without a native Claude id still functions, it just can't round-trip with Claude native resume.

Example flow:

```sh
the-librarian sessions list --project the-librarian
the-librarian sessions continue ses_123 --format claude > /tmp/lib-session.md
claude --append-system-prompt "$(cat /tmp/lib-session.md)"
```

### Codex Package

Primary surfaces:

- `AGENTS.md`,
- MCP configuration if supported,
- wrapper script,
- cwd/project-oriented session detection.

Requirements:

- `continue_session --format codex` should produce a concise `AGENTS`-style handover.
- Wrapper should preserve `LIBRARIAN_SESSION_ID` in the environment.
- Store source refs using cwd plus any native run/session id available.
- Default capture mode: `summary`.

Example source ref:

```text
cwd:/home/jim/the-librarian
```

### Pi Package

The Pi harness needs a thin, conservative package because capabilities may differ by device/runtime.

Requirements:

- Provide a minimal `AGENTS.md`/system-prompt snippet.
- Use HTTP MCP or CLI depending on availability.
- Prefer explicit `lib:` textual commands.
- Default capture mode: `off` or `summary`, never raw log by default.
- Include a low-dependency healthcheck.

Open question: define the exact Pi runtime interface before implementation.

### OpenCode Package

Primary surfaces:

- `opencode.json`,
- commands configuration,
- wrapper script,
- project cwd.

Requirements:

- Add `lib:` command examples in OpenCode command format where supported.
- Wrapper should set `LIBRARIAN_SESSION_ID` and record harness attachment.
- Store source refs using project cwd and OpenCode session metadata where available.
- `continue_session --format opencode` should produce an OpenCode-friendly context pack.

## Handover Package Format

A handover package should be compact, structured, and harness-neutral by default.

Template:

```markdown
# Librarian Session Handover

Session: [title]
ID: [session_id]
Project: [project_key]
Status: [status]
Created in: [harness/source]
Continuing in: [target_harness/source]
Last activity: [timestamp]

## Goal
[start or latest goal]

## Current Summary
[rolling summary]

## Decisions
- ...

## Files / Artefacts
- ...

## Commands / Checks
- ...

## Open Questions
- ...

## Next Steps
1. ...

## Durable Memory Notes
[Candidate facts to promote, if any.]

## Boundaries
- Treat this as session evidence, not automatically true durable memory.
- Use The Librarian `remember`/`propose_memory` only for durable facts.
```

Harness-specific formats may reorder or compress this, but should preserve the same semantics.

## Security and Privacy

### Redaction

Any log or transcript capture must redact:

- bearer tokens,
- API keys,
- GitHub tokens,
- cookies,
- `Authorization` headers,
- private key blocks,
- `.env`-style secret assignments,
- long high-entropy strings.

### Visibility

Sessions have a `visibility` column matching memory visibility: `common | agent_private`. Default is `common` because cross-agent sharing is the point of the layer; `agent_private` is opt-in via `--private` or via agent-driven sensitivity detection ([Principle 9](#principles)).

Filtering rules:

- `list_sessions` / `search_sessions` return: all `common` sessions visible to the caller's project scope, plus the caller's own `agent_private` sessions.
- A caller never sees another agent's `agent_private` sessions, even with `include_archived`/`include_deleted`.
- Admin role sees everything regardless of visibility.

A future `harness_private` visibility (sessions visible only within one harness, e.g. for sandbox/test traffic) is non-MVP.

### Deletion

`delete_session` is soft delete and is governed by ownership:

- An agent may soft-delete sessions where `created_by_agent_id == caller agent_id`.
- Deleting sessions owned by another agent requires admin role.
- Physical purge is out of scope for MVP and remains admin-only when added.
- Soft-deleted sessions can be restored by the owner (or admin) via `restore_session`.

### Protected Memory

Session summaries may mention identity or relationship facts as evidence, but promotion into durable `identity` or `relationship` categories must use `propose_memory` and the existing approval flow.

## Dashboard Requirements

Add a Sessions section to the dashboard.

Views:

1. Recent sessions list.
2. Active sessions list.
3. Archived/deleted filters (off by default).
4. Session detail page.
5. Search sessions.
6. Continue/handover view.
7. Archive/delete/restore controls.
8. Promote selected fact to memory/proposal.

Defaults:

- Archived sessions are excluded from default lists and from default search results. Toggle `include_archived` to include them.
- Deleted sessions are excluded everywhere except for admin views with `include_deleted` enabled.
- Active sessions with no events for more than 7 days are rendered with a "stale" age indicator but **not** auto-transitioned. There is no automatic idle-pause; the user/agent owns lifecycle transitions explicitly. The indicator is a soft prompt to clean up.

Session list columns:

- status (with stale-age indicator where applicable),
- title,
- project,
- visibility,
- harness,
- agent,
- source,
- last activity,
- next step.

## Testing Strategy

Use Node's built-in test runner, matching the existing project.

### Store Tests

Cover:

- session start creates events and projection rows,
- multiple active sessions can coexist,
- list ranking does not auto-select,
- checkpoint updates rolling summary,
- pause differs from end,
- archive hides from default list,
- delete hides from default list/search,
- rebuild from JSONL reproduces session state,
- long-thread start boundary is respected,
- promotion creates normal/proposed durable memory according to category.

### MCP Tests

Cover:

- session tools exposed to normal agents where appropriate,
- admin-only operations if any are added later,
- clean handover output,
- no memory ids or internal event ids in normal prose unless requested,
- private/protected semantics preserved.

### CLI Tests

Cover:

- `sessions list --json`,
- `sessions continue --format markdown`,
- archive/delete behaviour,
- invalid session id errors,
- harness format selection.

### Integration Package Tests

At minimum, validate that every referenced file exists and every documented command is syntactically plausible.

### Security Tests

Cover redaction of:

- bearer tokens,
- API keys,
- private keys,
- cookies,
- `.env` secrets.

## Commands

Existing commands:

```sh
npm test
npm run smoke
npm run rebuild
npm run serve
```

New or extended commands:

```sh
npm run healthcheck
npm run test:sessions
```

CLI examples:

```sh
node src/cli.js sessions list --json
node src/cli.js sessions continue ses_123 --format markdown
```

Actual script names may be adjusted to fit `package.json`, but docs and tests must agree.

## Implementation Plan

### Phase 1: Store-level session model

- Add session event constants for the MVP ledger event types.
- Add `sessions.jsonl` ledger writer (separate from existing `events.jsonl`).
- Add projection tables for `sessions`, `session_events`, and `session_events_fts`.
- Switch session writes to **incremental insert** (one row per appended event) rather than full rebuild, while keeping a full-rebuild path for recovery (`npm run rebuild` replays both ledgers).
- Add store methods for start/list/continue/attach/checkpoint/pause/end/archive/restore/delete/search/get/list_events/promote.
- Implement status transition table including implicit resume on activity and `prior_status` tracking for restore.
- Add store tests.

Checkpoint: `npm test` passes and JSONL rebuild reproduces session state.

### Phase 2: MCP tools

- Add MCP schemas and dispatch for session tools (including `get_session`, `list_session_events`, merged `continue_session`).
- Enforce visibility rules and delete-ownership rules at the dispatch layer.
- Ensure normal agent output is clean and compact.
- Add tests for tool surface and handover output.

Checkpoint: agents can manage sessions over MCP without dashboard or CLI.

### Phase 3: CLI and slash-command contract

- **Prerequisite:** refactor [src/cli.js](../src/cli.js) into a subcommand router. The current flat parser supports only `rebuild` / `seed`; the session namespace requires `sessions <subcommand>` dispatch.
- Add `sessions` CLI namespace covering start/list/continue/attach/checkpoint/pause/end/archive/restore/delete/search/show/events.
- Document canonical `lib:` slash commands.
- Add CLI tests.

Checkpoint: a harness without MCP-native slash commands can still use The Librarian through CLI calls.

### Phase 4: Dashboard

- Add Sessions dashboard view.
- Add detail, search, archive/delete/restore controls.
- Add promote-to-memory/proposal flow.

Checkpoint: Jim can browse and manage sessions manually.

### Phase 5: Harness setup packages

- Add `integrations/` packages for Hermes, Claude Code, Codex, Pi, and OpenCode.
- Add wrapper scripts where useful.
- Add healthcheck docs and examples.
- Add package validation tests.

Checkpoint: each supported harness has copyable setup docs and a clear `lib:` command story.

### Phase 6: Healthcheck and quality checks

- Add healthcheck command covering MCP reachability, auth, JSONL append, SQLite rebuild, and session lifecycle.
- Add optional recall/session benchmark later.

Checkpoint: setup failures are diagnosable without reading source code.

## Decisions Recorded

These were open questions during drafting; resolved choices are now baked into the spec above.

1. **Backend topology:** single shared Librarian over HTTP MCP. Local-only installs not supported for session continuity.
2. **Event storage:** separate `sessions.jsonl` ledger with incremental projection; memory rebuild path untouched.
3. **Visibility:** `common | agent_private`, default `common`, agent confirms with user when content signals sensitivity.
4. **Delete permissions:** owner soft-deletes own; admin deletes any. Soft-delete only for MVP.
5. **Status transitions:** standard lifecycle with `restore` returning to `prior_status` (falls back to `paused`).
6. **Attachment model:** singular `current_*` fields, attach overwrites, history in `session.attached_to_harness` events.
7. **Continue vs attach:** merged into `continue_session` with `attach: true` default; `attach_session` retained as a low-level helper.
8. **`promote_session_fact` input:** `session_id` + optional `session_event_id` + full memory payload; protected categories auto-route to proposal flow.
9. **Numbered selection:** agent-side scratch only; tool calls always require `session_id`.
10. **Event vocabulary:** explicit two-layer model — ledger event types wrap payload-level categories.
11. **`source_ref` format:** colon-separated URI-style with documented per-harness prefixes.
12. **List ranking:** lexicographic by (status, project match, source match, has next steps, recency).
13. **Read tools:** `get_session` and `list_session_events` added to MCP surface.
14. **Title handling:** optional in input; server generates placeholder when missing.
15. **Summary fields:** `updated_at` added; checkpoint and pause overwrite `rolling_summary`; end freezes it and writes `end_summary`.
16. **Log capture:** this spec does not define a log-ingestion tool; cross-references `proposals/safe-fallback-capture.md`.
17. **Idle policy:** no auto-pause; dashboard surfaces stale sessions with an age indicator.
18. **Slash parsing:** `/lib:session` is the command; remainder is subcommand + args.
19. **Restore in slash UX:** `/lib:session restore <id>` added.
20. **Hermes slash:** native where Hermes supports it, text fallback in skill/agent contexts.
21. **Claude metadata:** best-effort capture from env vars and CLI flags.
22. **Archived in dashboard search:** excluded by default; opt-in via `include_archived`.

## Open Questions (Future Work)

1. What exactly is the Pi harness interface: local CLI, remote shell, Hermes profile, or something else? (blocks Pi package implementation, not the rest of the spec)
2. Should a `harness_private` visibility be added later for sandbox/test traffic?
3. When physical purge of deleted sessions is added, what retention policy and admin UI should it have?
4. Should `session.split` / `session.merged` (deferred event types) be revisited once usage patterns emerge?

## Acceptance Criteria

- The Librarian stores sessions as event-sourced data in `sessions.jsonl` with rebuildable SQLite projections, separate from the existing memory ledger.
- Session writes use incremental projection; memory write performance is unaffected by session traffic.
- Multiple active sessions are supported and normal.
- `list_sessions` provides explicit selectable results, ranked lexicographically by (status, project match, source match, has next steps, recency), and never auto-resumes.
- `continue_session` produces a useful handover package for a selected session and (by default) records attachment to the target harness in the same call.
- The status state machine matches the documented transition table, including implicit resume on activity and `restore` returning to `prior_status`.
- Session visibility (`common | agent_private`) is enforced at the MCP dispatch layer; agents never see another agent's private sessions.
- `delete_session` enforces owner-or-admin permissions.
- `get_session` and `list_session_events` are available over MCP for inspection without generating a handover.
- `promote_session_fact` creates active or proposed durable memories per existing category rules and links provenance back to the source session/event.
- Long Discord threads use explicit `/lib:session start` boundaries (agent policy enforced in the skill, not the store).
- Session history is separate from durable memory recall.
- Users can archive and soft-delete throwaway sessions and restore them to their prior status.
- Harness packages exist for Hermes, Claude Code, Codex, Pi, and OpenCode, with `AGENTS.append.md` / `wrapper.sh` / `healthcheck.md` conventions documented.
- All slash-command docs use the `lib:` prefix, parsed as `/lib:session` + subcommand.
- Tests cover store, MCP (including visibility/ownership), CLI, and redaction behaviour.
- Existing memory functionality and tests remain backwards-compatible.

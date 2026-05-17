# Spec: Cross-Harness Session Layer and Harness Setup Packages

## Status

Draft for review.

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

## Non-goals

- Do not replace Claude Code's native resume, Hermes Discord thread continuation, or other harness-native mechanisms.
- Do not summarise an entire long-running Discord thread by default.
- Do not auto-promote session details into durable memory.
- Do not require vector search for MVP.
- Do not require every harness to expose the same native capabilities.
- Do not make `/session` or similarly generic slash commands; use the `lib:` prefix to avoid conflicts.

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

The concrete location or native session reference in a harness.

Examples:

- Discord thread id,
- terminal cwd,
- Claude native session id,
- Codex run/session id,
- OpenCode project directory,
- Pi device/session id.

### Librarian Session

A user/task-bounded unit of work tracked by The Librarian. It can be created in one harness and resumed in another.

### Checkpoint

A structured mid-session summary that preserves progress before context loss, compaction, harness exit, or a work break.

### Handover

A compact context package generated from session data for continuing work in any harness.

### Workstream

A possible future grouping abstraction for related sessions. Not part of MVP.

## Data Model

### Session Fields

Derived SQLite projection table: `sessions`.

```text
sessions
- id text primary key
- title text not null
- project_key text
- status text not null -- active | paused | ended | archived | deleted
- created_by_agent_id text
- current_agent_id text
- created_in_harness text
- current_harness text
- source_ref text
- cwd text
- start_summary text
- rolling_summary text
- end_summary text
- next_steps_json text
- tags_json text
- capture_mode text not null -- off | summary | log
- started_at text not null
- last_activity_at text not null
- paused_at text
- ended_at text
- archived_at text
- deleted_at text
- metadata_json text
```

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

Store raw or near-raw transcript/log fragments after redaction. Off by default and excluded from durable memory recall.

## Canonical Event Types

Session state must be reconstructable from JSONL events.

Add these event types:

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

Optional later:

```text
session.split
session.merged
session.purged
```

## MCP Tool Surface

### `start_session`

Creates a new Librarian session and records a start summary.

Input:

```json
{
  "agent_id": "bede",
  "title": "Cross-harness session recall design",
  "project_key": "the-librarian",
  "harness": "hermes",
  "source_ref": "discord-thread:1504245255925665854",
  "cwd": "/home/jim/the-librarian",
  "capture_mode": "summary",
  "start_summary": "Jim wants a cross-harness session recall layer...",
  "tags": ["sessions", "librarian"]
}
```

Output should include the session id and a short confirmation suitable for a human.

### `list_sessions`

Returns selectable sessions. This is the default resume entry point.

Input:

```json
{
  "agent_id": "bede",
  "project_key": "the-librarian",
  "status": ["active", "paused", "ended"],
  "harness": null,
  "include_archived": false,
  "include_deleted": false,
  "limit": 10
}
```

Ranking:

1. active sessions,
2. same project/cwd/source,
3. explicit next steps,
4. recent activity,
5. same harness,
6. paused,
7. ended.

The tool may mark a “most likely” session but must not auto-select one.

### `continue_session`

Generates a cross-harness handover package.

Input:

```json
{
  "agent_id": "bede",
  "session_id": "ses_...",
  "target_harness": "claude-code",
  "format": "prose"
}
```

Output should include:

- title,
- project,
- status,
- original harness/source,
- latest harness/source,
- start summary,
- rolling summary,
- end summary if any,
- decisions,
- commands,
- files touched,
- open questions,
- next steps,
- harness-specific resume notes.

### `attach_session`

Records that an existing Librarian session is now being continued in another harness/source.

Input:

```json
{
  "agent_id": "bede",
  "session_id": "ses_...",
  "harness": "codex",
  "source_ref": "cwd:/home/jim/the-librarian",
  "cwd": "/home/jim/the-librarian"
}
```

This supports one logical session being continued across multiple tools.

### `record_session_event`

Records structured evidence within a session.

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

Allowed event categories should include:

```text
message
command
file
error
decision
question
checkpoint
handover
note
```

### `checkpoint_session`

Updates rolling session state.

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

### `pause_session`

Marks a session paused and stores a pause summary. Harness process exit should generally pause, not end.

### `end_session`

Marks a session ended and stores a final summary.

Input should include:

- summary,
- decisions,
- files touched,
- commands run,
- unresolved questions,
- next steps,
- candidate durable memories.

The tool should not automatically save candidate durable memories. It may return suggested `remember` or `propose_memory` calls.

### `archive_session`

Hides a session from normal resume lists while retaining searchability.

### `restore_session`

Restores an archived or soft-deleted session where permitted.

### `delete_session`

Soft-deletes a session. Physical purge is out of scope for MVP and should later be admin-only.

### `search_sessions`

Searches session summaries and events, separate from durable memory recall.

Input:

```json
{
  "agent_id": "bede",
  "query": "Shokunin BM25 session recall",
  "project_key": "the-librarian",
  "include_archived": true,
  "limit": 5
}
```

### `promote_session_fact`

Creates a durable memory or proposal from selected session evidence.

Protected categories must still use proposals.

## CLI Surface

Add a `sessions` namespace to the existing CLI.

Commands:

```sh
the-librarian sessions start --title "..." --project the-librarian --harness codex --cwd "$PWD"
the-librarian sessions list --project the-librarian
the-librarian sessions continue ses_123 --format prose
the-librarian sessions attach ses_123 --harness claude-code --cwd "$PWD"
the-librarian sessions checkpoint ses_123 --summary-file checkpoint.md
the-librarian sessions pause ses_123 --summary-file pause.md
the-librarian sessions end ses_123 --summary-file end.md
the-librarian sessions archive ses_123 --reason "throwaway spike"
the-librarian sessions delete ses_123 --reason "test session"
the-librarian sessions search "BM25 recall" --project the-librarian
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

Canonical commands:

```text
/lib:session start [title]
/lib:session list
/lib:session resume <number|session_id>
/lib:session checkpoint
/lib:session pause
/lib:session end
/lib:session archive <number|session_id>
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
/lib:delete
/lib:search
/lib:status
```

The long form is canonical for docs and tests.

### `/lib:session start [title]`

Expected behaviour:

1. Determine harness, source, cwd, agent id, and project if available.
2. Call `start_context` for durable memory context.
3. Create a start summary from current visible context plus selected prior sessions if any.
4. Call `start_session`.
5. Return the session id and a one-paragraph baseline.

If the surface is a long-running Discord thread, this command defines the lower bound for future summary. The agent should not later summarise the whole historical thread unless explicitly asked and technically able.

### `/lib:session list`

Expected behaviour:

1. Call `list_sessions` scoped to current project/source where possible.
2. Return numbered choices.
3. Include status, title, project, harness, source, last activity, and next step.
4. Do not auto-resume.

### `/lib:session resume <number|session_id>`

Expected behaviour:

1. Resolve the numbered selection from the last list response or accept a session id.
2. Call `continue_session` with the current harness as target.
3. Call `attach_session` if the session is being continued in a new harness/source.
4. Inject or display the handover package according to harness capabilities.

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

### `/lib:session delete <number|session_id>`

Expected behaviour:

1. Resolve session.
2. Ask for confirmation where the harness supports interactive confirmation.
3. Call `delete_session` for soft deletion.
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

A Discord thread is a source/container, not a session.

Rules:

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
- possibly Hermes slash command wiring.

Requirements:

- Load or reference `skills/use-the-librarian/SKILL.md`.
- Add `lib:` slash command handling where Hermes supports slash-style commands.
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
- If Claude native resume is used, record the native id in `source_ref` or `metadata_json`.

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

Session visibility should follow the same broad principles as memory visibility, but MVP can start with common project sessions plus agent attribution.

Future extension:

```text
visibility: common | agent_private | harness_private
```

### Deletion

`delete_session` is soft delete. Physical purge requires separate admin-only design.

### Protected Memory

Session summaries may mention identity or relationship facts as evidence, but promotion into durable `identity` or `relationship` categories must use `propose_memory` and the existing approval flow.

## Dashboard Requirements

Add a Sessions section to the dashboard.

Views:

1. Recent sessions list.
2. Active sessions list.
3. Archived/deleted filters.
4. Session detail page.
5. Search sessions.
6. Continue/handover view.
7. Archive/delete/restore controls.
8. Promote selected fact to memory/proposal.

Session list columns:

- status,
- title,
- project,
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

- Add session event constants.
- Add projection tables for `sessions`, `session_events`, and `session_events_fts`.
- Extend rebuild logic.
- Add store methods for start/list/continue/checkpoint/pause/end/archive/delete/search.
- Add store tests.

Checkpoint: `npm test` passes and JSONL rebuild reproduces session state.

### Phase 2: MCP tools

- Add MCP schemas and dispatch for session tools.
- Ensure normal agent output is clean and compact.
- Add tests for tool surface and handover output.

Checkpoint: agents can manage sessions over MCP without dashboard or CLI.

### Phase 3: CLI and slash-command contract

- Add `sessions` CLI namespace.
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

## Open Questions

1. What exactly is the Pi harness interface: local CLI, remote shell, Hermes profile, or something else?
2. Should session visibility be `common` only for MVP, or should agent-private sessions exist immediately?
3. Should `delete_session` require admin rights, or is soft-delete safe for normal agents?
4. Should Hermes implement actual slash commands, or should `lib:` commands initially be interpreted as text by the agent?
5. How much native Claude Code session metadata can be captured reliably?
6. Should archived sessions remain searchable by default in dashboard search, or only when `include_archived` is enabled?

## Acceptance Criteria

- The Librarian stores sessions as event-sourced data with rebuildable SQLite projections.
- Multiple active sessions are supported and normal.
- `list_sessions` provides explicit selectable results and never auto-resumes solely by recency.
- `continue_session` produces a useful handover package for a selected session.
- Long Discord threads use explicit `/lib:session start` boundaries.
- Session history is separate from durable memory recall.
- Session facts can be promoted to durable memory through existing memory/proposal rules.
- Users can archive and soft-delete throwaway sessions.
- Harness packages exist for Hermes, Claude Code, Codex, Pi, and OpenCode.
- All slash-command docs use the `lib:` prefix.
- Tests cover store, MCP, CLI, and redaction behaviour.
- Existing memory functionality and tests remain backwards-compatible.

# Spec: Harness Commands, Private Mode, and Lifecycle Automation

**Author:** Guybrush, with Jim
**Date:** 2026-05-23
**Status:** Draft — revised after stronger-model review

---

## 1. Purpose

Make The Librarian easier and safer to use across agent harnesses.

This spec defines:

1. a cross-harness **private/off-record mode** that disables both session storage and memory writes;
2. command surfaces for enabling/disabling that mode and managing sessions;
3. conservative lifecycle automation so sessions are started, checkpointed, paused, and resumed without Jim manually triggering every event.

The design deliberately does **not** automatically end sessions in v1.

---

## 2. Non-negotiable privacy rule

When private/off-record mode is active, the harness/integration must make **zero calls to The Librarian**:

- no `start_context`;
- no `recall`;
- no `start_session`;
- no session events;
- no checkpoint/pause/end calls;
- no `remember` or `propose_memory`;
- no metadata stored saying a private session occurred.

This mode is not the same as `agent_private` visibility. `agent_private` data is stored. Off-record private data is not stored at all.

Privacy enforcement must happen before normal agent Librarian behaviour. Agent prompt instructions are only a fallback, not the primary guarantee.

If a harness cannot provide a synchronous pre-agent privacy gate, then that harness cannot honestly claim zero-call private mode yet. In that case the integration must either run through a wrapper/gateway that provides the gate, or clearly mark private detection as best-effort and disable automatic Librarian startup until the gate exists.

---

## 3. Privacy triggers

### 3.1 Canonical commands

Where the harness supports commands through a real command handler or pre-submit interceptor, expose these operations:

```text
/lib:session private      # enter off-record mode locally; do not call The Librarian
/lib:session public       # leave off-record mode locally
/lib:session mode         # may show local privacy/session state without storing anything
```

Harnesses with per-command file naming may expose aliases:

```text
/lib-session-private
/lib-session-public
/lib-session-mode
```

`private` and `public` are local harness commands. They must not be implemented as Librarian MCP tools because calling an MCP tool to say “be private” would already touch The Librarian.

Prompt-only command files are not enough for the privacy guarantee. They can improve discoverability, but the actual state change must happen in a synchronous local command handler, gateway middleware, prompt-submit hook, wrapper, or plugin that runs before the model can make any Librarian MCP/CLI call.

### 3.2 Start flag

Support private start flags where applicable:

```text
/lib:session start --private
<wrapped-harness> --private
```

A private start flag means “do not start a Librarian session”. It does not create an `agent_private` stored session.

### 3.3 Plain-text markers

Detect explicit phrases before normal Librarian calls where the harness allows prompt-submit/gateway pre-processing:

```text
this is a private session
don't remember this
do not remember this
don't save this
do not save this
don't store this
off the record
keep this between us
private from here
```

Exit phrases:

```text
you can remember again
end private mode
back on the record
this can be remembered
```

Use exact or near-exact phrase matching only. Do not use an aggressive semantic classifier in v1.

Same-message precedence is deliberately conservative:

- if a prompt contains a private marker and substantive content, the whole prompt is treated as private and no Librarian call is made;
- if a prompt contains an exit-private marker plus substantive content, the mode change is applied locally but the substantive content is not stored; public Librarian behaviour resumes from the next prompt;
- pure command prompts such as `/lib:session public` may update local state immediately.

---

## 4. Local privacy and session state

Every harness integration needs local state. Do not rely only on `LIBRARIAN_SESSION_ID`, because hooks generally cannot export environment variables back into an already-running parent process.

### 4.1 State shape

```ts
interface HarnessLibrarianState {
  version: 1;
  harness: "claude-code" | "codex" | "hermes" | "opencode" | "pi";
  harness_session_key: string;
  source_ref?: string;
  cwd?: string;
  project_key?: string;
  librarian_session_id?: string;
  privacy: "public" | "private";
  entered_private_at?: string;
  last_activity_at?: string;
  last_checkpoint_at?: string;
}
```

This state is local to the harness machine/process. It must not contain private prompt text or summaries.

### 4.2 Storage location

Recommended default:

```text
~/.librarian/harness-state/<harness>/<hash>.json
```

The hash should be derived from available non-secret local identifiers such as harness session id, cwd, source ref, and project key.

Hermes gateway integrations may hold some state in memory, but they should persist enough to survive gateway restarts if possible.

State directory permissions should be `0700`; state files should be `0600`; updates should use lock + atomic write/rename. If local privacy state cannot be read or written, the integration must fail closed: do not call The Librarian automatically.

### 4.3 Private transition when a Librarian session is already attached

If a public Librarian session is attached and privacy is detected:

1. set local `privacy = private`;
2. keep `librarian_session_id` in local state but dormant;
3. do not call checkpoint/pause/end;
4. suppress all future Librarian calls until public mode resumes.

A stored Librarian session may remain active longer than reality. That is acceptable. The alternative is recording evidence about the private boundary, which is worse.

When public mode resumes after a private segment, v1 should start a new public Librarian session by default rather than automatically reusing the dormant pre-private session. Reuse the old session only when Jim explicitly resumes it or when the public command is a pure local command immediately followed by an explicit “continue the previous public session” instruction.

---

## 5. Lifecycle semantics

### 5.1 Actions

| Harness event | Librarian action | Notes |
|---|---|---|
| First non-private meaningful prompt | Start or resume | Prefer existing active/paused match by `source_ref`/`cwd`/project. |
| Session/harness start with no prompt yet | Usually none | Opening a tool should not create a Librarian session by itself. |
| Context compaction | Checkpoint | High-value boundary. |
| Explicit task completion | Checkpoint | Gate by meaningful work. |
| Significant tool/file activity since last checkpoint | Checkpoint | Rate-limited. |
| Harness exit/reset/long idle | Pause | Do not end in v1. |
| Explicit `/lib:session end` | End | User/agent has intentionally ended the bounded work. |
| Private mode active | No action | Zero interaction. |

### 5.2 Start/resume algorithm

When automation needs a session and privacy is public:

1. If local state has `librarian_session_id`, verify it is visible/resumable when cheap to do so.
2. Else list active/paused sessions matching strongest available key:
   - exact `source_ref` for Discord/Slack/etc.;
   - exact `cwd` + `project_key` for coding harnesses;
   - current harness session id if stored in metadata later.
3. If exactly one good match exists, continue/resume it.
4. If none exists, start a new session with a concise start summary.
5. If multiple plausible matches exist and a user is present, ask/list. If unattended, start a new session rather than guessing.

Ended sessions are not auto-resumed in v1. They require explicit user action.

If local state indicates `entered_private_at` was set since the attached session was last public, do not apply step 1 automatically. Start a fresh public session or ask Jim which one to resume.

### 5.3 Checkpoint gates

Automatic checkpointing must pass at least one gate:

- compaction event occurred;
- explicit task-completed event exists;
- files touched since last checkpoint ≥ configured threshold;
- commands/tools run since last checkpoint ≥ configured threshold;
- elapsed time since last checkpoint ≥ configured threshold and there was new work;
- agent supplied a meaningful summary.

Default thresholds:

```yaml
lifecycle:
  checkpoint_min_interval_minutes: 30
  checkpoint_min_files_touched: 2
  checkpoint_min_tool_calls: 5
  pause_idle_after_hours: 6
```

These are defaults, not hard-coded constants.

### 5.4 End policy

No automatic end in v1.

`end` happens only when:

- Jim explicitly uses `/lib:session end` or equivalent;
- an agent deliberately ends after being asked to wrap up;
- an admin marks a session ended in the dashboard/CLI.

Harness reset/new/exit should pause, not end.

---

## 6. Shared helper package

Add a shared helper used by hook scripts/plugins/wrappers:

```text
integrations/shared/librarian-lifecycle/
  state.ts or state.py
  privacy.ts
  session.ts
  cli.ts
  README.md
```

Responsibilities:

- load/save local state;
- detect privacy markers;
- short-circuit when private;
- call The Librarian CLI with consistent flags;
- rate-limit checkpoints;
- normalise source refs/cwd/project keys;
- handle idempotent start/resume/pause.

The shared helper should be dependency-light because it will run in several harness environments.

---

## 7. Harness-specific implementation

### 7.1 Claude Code

#### Commands

Add command files:

```text
integrations/claude-code/.claude/commands/
  lib-session-private.md
  lib-session-public.md
  lib-session-mode.md
```

Existing session commands remain:

```text
lib-session-start.md
lib-session-list.md
lib-session-resume.md
lib-session-checkpoint.md
lib-session-pause.md
lib-session-end.md
lib-session-search.md
```

Private/public command files are discoverability aids, not the enforcement mechanism. The actual privacy transition must be handled by `UserPromptSubmit` or another synchronous local command path before Claude can make Librarian calls. If that hook is unavailable or fails, automatic Librarian startup must be disabled for that turn.

#### Hooks

Ship hook scripts under:

```text
integrations/claude-code/hooks/librarian/
  user-prompt-submit.(sh|py)
  session-start.(sh|py)
  session-end.(sh|py)
  post-compact.(sh|py)
  task-completed.(sh|py)
```

Hook mapping:

| Claude event | Action |
|---|---|
| `UserPromptSubmit` | Detect private/public markers and commands; update local state before other Librarian hooks do work. |
| `SessionStart` | Initialise local state only; start/resume only if a meaningful prompt is available or wrapper policy says to attach immediately. |
| `PostCompact` | Checkpoint if public and attached. |
| `TaskCompleted` | Gated checkpoint if public and attached. |
| `SessionEnd` | Pause if public and attached. |
| `Stop` | No lifecycle mutation by default; optional activity heartbeat. |

Do not depend on hooks exporting `LIBRARIAN_SESSION_ID` back to Claude. Use local state.

### 7.2 Hermes Agent

#### Commands

Extend the Hermes `/lib:session` command parser:

```text
/lib:session private
/lib:session public
/lib:session mode
```

`private` and `public` are handled by Hermes/gateway local state. They are not forwarded to The Librarian.

#### Gateway behaviour

Implement synchronous gateway middleware under:

```text
integrations/hermes/middleware/librarian-lifecycle/
  ...
```

Hermes gateway hooks are useful for non-blocking lifecycle work, but they are not sufficient as the privacy barrier. The private/public command and plain-text marker detection must run in the command/message path before `agent:start` and before any automatic Librarian call. If the middleware cannot evaluate privacy state, it must fail closed and suppress Librarian automation for that message.

Events:

| Hermes event | Action |
|---|---|
| `command:*` | Recognise local private/public/status commands before agent execution. |
| message pre-processing if available | Detect plain-text private/public markers. |
| `agent:start` | Ensure a public session is attached before normal Librarian use. |
| `agent:end` | Gated checkpoint if meaningful work occurred. |
| `session:end` / `session:reset` | Pause if public and attached. |

For Discord, use `source_ref` in the canonical form:

```text
discord:channel:{channel_id}:thread:{thread_id}
```

A top-level channel without a thread uses:

```text
discord:channel:{channel_id}
```

Long Discord threads can contain multiple Librarian sessions over time. Automation should attach to active/paused sessions, not ended sessions, and should not summarise messages before the selected session’s start boundary.

### 7.3 Codex

#### Commands

Codex does not currently have a proven Claude/OpenCode-style custom command directory. Ship:

```text
integrations/codex/skills/lib-session/SKILL.md
```

and strengthen:

```text
integrations/codex/AGENTS.md
```

The skill/instructions must cover:

- `/lib:session <verb>` text recognition;
- private/public phrases;
- no Librarian calls in private mode;
- explicit `agent_id` use once the naming contract lands.

This instruction path is best-effort only. It does not satisfy the zero-call privacy guarantee by itself, because the model sees the prompt before obeying the instruction. For guaranteed privacy, Codex must run with `UserPromptSubmit` hooks enabled or through a wrapper that gates prompts before agent execution. Until then, disable Codex automatic Librarian startup by default.

If future Codex releases add stable custom command files, add per-verb commands then.

#### Hooks

Codex hooks are behind `codex_hooks = true`. Ship optional hooks:

```text
integrations/codex/hooks/librarian/
  user-prompt-submit.py
  session-start.py
  stop.py
  pause-idle.py   # optional wrapper/timer helper, not a Codex hook event
```

Mapping:

| Codex event | Action |
|---|---|
| `UserPromptSubmit` | Detect private/public markers and update local state. |
| `SessionStart` | Initialise/start/resume if public and policy allows. |
| `Stop` | Gated checkpoint or heartbeat only. Do **not** pause every turn. |
| Wrapper exit / idle timer | Pause if public and attached. |

Codex matching hooks may run concurrently. Scripts must use file locks around local state updates.

### 7.4 OpenCode

#### Commands

OpenCode supports custom Markdown commands. Add:

```text
integrations/opencode/.opencode/commands/
  lib-session-private.md
  lib-session-public.md
  lib-session-mode.md
```

Retain existing per-verb session commands.

Command files may be prompt-based, so privacy must be enforced by the plugin or another synchronous pre-agent path. Without that plugin, OpenCode private commands are discoverability only and automatic Librarian startup should remain disabled.

#### Plugin

Implement lifecycle in a plugin rather than waiting for Claude-style declarative hooks:

```text
integrations/opencode/plugins/librarian-lifecycle.ts
```

Use documented OpenCode plugin events, subject to validation in a spike:

| OpenCode event | Action |
|---|---|
| `command.executed` / `tui.command.execute` | Detect private/public commands. |
| prompt/message event if exposed | Detect natural-language privacy markers. |
| `session.created` | Initialise local state and attach if public. |
| `session.compacted` | Checkpoint if public and attached. |
| `session.idle` | Pause after configured idle threshold. |
| `session.updated` | Optional activity heartbeat. |

Because plugin APIs evolve, include an integration test or manual smoke test against the installed OpenCode version before marking this Tier 1.

### 7.5 Pi

Pi is a minimal tool but has a great package repository with lots of add-ons but  it supports custom commands and many other features via extensions: https://pi.dev/docs/latest/extensions

The extensions page mentions [Session Events](https://pi.dev/docs/latest/extensions#session-events), for example:

- session_start
- session_before_compact (could be a good checkpoint trigger?)
- session_shutdown

Could we use those for our librarian session triggers?

If not, there are many packages available. These ones look promising for session hooks:

- https://pi.dev/packages/pi-yaml-hooks?name=hooks
- https://pi.dev/packages/@vahor/pi-hooks?name=hooks

To ship:

- investigate the add-on options and pick the best suited;
- recognise explicit private/public markers;
- never call The Librarian in private mode.

This is a best-effort agent instruction, not a privacy guarantee. Do not enable Pi automatic Librarian startup until there is a wrapper or runtime hook that can gate private markers before the agent runs.

Revisit when Pi’s runtime exposes a stable command or hook API.

---

## 8. CLI integration

Hook scripts should prefer the CLI over MCP during shutdown paths, because MCP calls may be unavailable or slow during process teardown.

Required CLI capabilities, some existing and some to verify:

```text
the-librarian sessions start --agent <agent> --harness <harness> --source-ref <ref> --cwd <cwd> --project <key> --summary <summary>
the-librarian sessions list --agent <agent> --source-ref <ref> --cwd <cwd> --status active --status paused --json
the-librarian sessions continue <session_id> --agent <agent> --json
the-librarian sessions checkpoint <session_id> --agent <agent> --summary-file <path>
the-librarian sessions pause <session_id> --agent <agent> --summary-file <path>
```

If a required CLI flag does not exist yet, implement it before wiring hooks around it.

Private/public commands do not call this CLI. They update local state only.

---

## 9. Idempotency and concurrency

All automation scripts must tolerate retries and concurrent hook firing.

Requirements:

- local state writes use atomic write + rename;
- multi-hook harnesses use a lock file around local state changes;
- start/resume handles an already attached session;
- pause handles already paused/ended/missing sessions gracefully;
- checkpoint includes a content hash or timestamp gate to avoid duplicate checkpoints;
- private mode is checked before acquiring remote/session state;
- hook failures are logged locally but do not block the user unless privacy enforcement itself cannot run;
- if privacy enforcement cannot run, fail closed by suppressing all automatic Librarian calls for that turn/session.

---

## 10. Configuration

Suggested shared config:

```yaml
librarian_lifecycle:
  enabled: true
  privacy_detection: true
  auto_start: true
  auto_resume: true
  auto_pause: true
  auto_end: false
  checkpoint:
    on_compaction: true
    on_task_completed: true
    min_interval_minutes: 30
    min_files_touched: 2
    min_tool_calls: 5
  idle_pause_after_hours: 6
  private_markers:
    - "this is a private session"
    - "don't remember this"
    - "off the record"
  public_markers:
    - "you can remember again"
    - "end private mode"
```

Harness-specific config can override defaults, but `auto_end: false` should remain the v1 default everywhere.

---

## 11. Tests and verification

### 11.1 Shared tests

- private marker detection catches explicit phrases;
- same-message private markers treat the whole prompt as off-record;
- exit-private markers with substantive content resume public mode only from the next prompt;
- false positives are not triggered by unrelated text;
- public marker exits local private state;
- when private, no mocked CLI/MCP call is made;
- state directory/file permissions are `0700`/`0600`;
- state read/write failure suppresses remote calls;
- state writes are atomic;
- concurrent start hooks produce one attached session;
- duplicate checkpoint input is skipped/rate-limited;
- pause is idempotent.

### 11.2 Harness tests

Claude Code:

- `UserPromptSubmit` private marker sets local private state;
- `PostCompact` checkpoints only when public;
- `SessionEnd` pauses only when public and attached.

Hermes:

- `/lib:session private` is handled locally and not forwarded to The Librarian;
- privacy handling runs in synchronous middleware, not only in a non-blocking hook;
- Discord `source_ref` includes channel and thread where available;
- long-thread attach chooses active/paused sessions only.

Codex:

- hooks respect `codex_hooks` feature flag configuration;
- without a pre-agent hook/wrapper, privacy is marked best-effort and auto-start remains disabled;
- `Stop` does not pause every turn;
- file locking prevents concurrent hook state corruption.

OpenCode:

- command files appear in command list;
- plugin receives expected session events on installed version;
- without the plugin/pre-agent path, privacy commands are not advertised as guaranteed;
- `session.compacted` checkpoints; `session.idle` pauses after threshold.

Pi:

- integration docs include the privacy contract and text command recognition.

### 11.3 Manual smoke tests

For each implemented harness:

1. Start a normal task; verify a Librarian session starts or resumes.
2. Say “this is a private session”; verify no new Librarian calls occur.
3. Say “you can remember again”; verify public behaviour resumes.
4. Trigger compaction/task completion where possible; verify checkpoint quality.
5. Exit/reset/idle; verify pause, not end.

---

## 12. Rollout plan

1. Add shared privacy contract to all integration instruction files.
2. Implement shared local state/privacy helper.
3. Implement Claude Code private/public commands and hooks.
4. Implement Hermes gateway private/public handling and lifecycle pause/checkpoint.
5. Implement Codex optional hooks and skill/instruction improvements.
6. Spike OpenCode plugin event payloads, then implement if confirmed.
7. Leave Pi as docs-only until its runtime is defined.
8. After one week of use, review session noise and checkpoint quality before increasing automation.

---

## 13. Success criteria

- [ ] Every harness integration documents the zero-interaction private rule.
- [ ] Harnesses with command support expose private/public controls.
- [ ] Plain-text private markers are detected before normal Librarian calls where synchronous hooks/gateway/wrappers support it.
- [ ] Harnesses without a pre-agent privacy gate do not enable automatic Librarian startup.
- [ ] Private mode suppresses sessions and memories.
- [ ] First meaningful public interaction can start/resume a session automatically.
- [ ] Compaction/task boundaries create useful checkpoints where supported.
- [ ] Exit/reset/idle pauses sessions, not ends them.
- [ ] No v1 automation auto-ends a session.
- [ ] Hook scripts/plugins use local state rather than environment-only state.
- [ ] Automation is idempotent and safe under retries.

---

## 14. Explicit non-goals

- No raw transcript capture.
- No server-side filtering as the main privacy mechanism.
- No auto-end heuristics in v1.
- No attempt to infer Pi lifecycle without a real API.
- No memory-curator behaviour in this spec; that is separate.

---

## 15. Open questions

1. Should the canonical command be `/lib:session private`, `/private`, or both?
2. What exact idle threshold fits Jim’s Discord usage?
3. Should Hermes gateway privacy state persist across gateway restarts?
4. Should Codex hooks be opt-in only until the feature flag graduates?
5. Should OpenCode plugin support be treated as Tier 1 after a successful spike?

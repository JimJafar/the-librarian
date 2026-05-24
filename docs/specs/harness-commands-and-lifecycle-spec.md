# Spec: Harness Commands, Private Mode, and Lifecycle Automation

**Author:** Guybrush, with Jim
**Date:** 2026-05-23
**Status:** Draft — revised after stronger-model review; Codex & Pi promoted to first-class (real pre-prompt gates), OpenCode scoped to a plugin spike (no pre-prompt hook), private mode redefined as end-the-session-with-reason, and the privacy control collapsed to a single `/lib:toggle-private` command; plus per-harness marketplace distribution (claude-code re-review 2026-05-23)

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
- no metadata stored about anything said off-record.

There is exactly one permitted call at the **moment of transition into** private mode: if a public session is currently attached, it is **ended** with a short, content-free reason such as `"switching to private mode"` (see §4.3). That call closes the *public* session — it stores nothing about the off-record content that follows. Naming "went private" as the end reason is intentional: it gives an admin reviewing their session history visible confirmation that the system stopped recording when asked.

This mode is not the same as `agent_private` visibility. `agent_private` data is stored. Off-record private data is not stored at all. There is no such thing as a "private session" — privacy means *no* session exists for that period.

Privacy enforcement must happen before normal agent Librarian behaviour. Agent prompt instructions are only a fallback, not the primary guarantee.

If a harness cannot provide a synchronous pre-agent privacy gate, then that harness cannot honestly claim zero-call private mode yet. In that case the integration must either run through a wrapper/gateway that provides the gate, or clearly mark private detection as best-effort and disable automatic Librarian startup until the gate exists.

---

## 3. Privacy triggers

### 3.1 Canonical command

Where the harness supports commands through a real command handler or pre-submit interceptor, expose **one** local command that toggles off-record mode:

```text
/lib:toggle-private       # flip off-record mode; echo the resulting state ("now private" / "now public")
```

Harnesses with per-command file naming expose it as:

```text
/lib-toggle-private
```

This mirrors the existing `/lib:session <verb>` ↔ `/lib-session-*` convention: `lib:` is the canonical prefix, and harnesses that name commands by file or otherwise reserve `:` (Claude Code, OpenCode, and Pi's command registry) render it with a hyphen.

One verb, not three. The command flips the current mode and reports the state it landed in, so there is no separate "set private", "set public", or "show mode" verb to remember (objective: keep the surface minimal). For the unambiguous *enter-privacy* direction, the natural-language markers in §3.3 ("off the record", etc.) remain directional and are the primary path when certainty matters.

`toggle-private` is a local harness command. It must not be implemented as a Librarian MCP tool, because calling an MCP tool to say “be private” would already touch The Librarian. The one Librarian call it may make is the public-session **end** described in §2/§4.3, when toggling *from* public *to* private with a session attached.

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
- pure command prompts such as `/lib-toggle-private` may update local state immediately.

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

1. **end** the attached session with a short, content-free reason (e.g. `"switching to private mode"`);
2. clear `librarian_session_id` from local state;
3. set local `privacy = private` and record `entered_private_at`;
4. suppress all future Librarian calls until public mode resumes.

Ending — rather than leaving the session "dormant" — is deliberate. A session that lingers `active` while the user has gone off-record misrepresents reality; a clean `ended` with a neutral reason is honest and reassures the admin that recording stopped on request. The end summary names *only* that the user went private; it carries nothing about what is said afterwards.

When public mode resumes after a private segment, a **new** public session starts on the next meaningful prompt. The previously ended session is never silently reattached; resuming it requires explicit user action (`/lib-session-resume <id>`), exactly as for any other ended session.

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
| Enter private mode while a session is attached | End (reason: switching to private mode) | One-time, user-initiated; then zero interaction. See §4.3. |
| Private mode already active | No action | Zero interaction. |

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

No automatic *heuristic* end in v1. The system never ends a session on its own guess about whether work is "done".

`end` happens only when:

- Jim explicitly uses `/lib:session end` or equivalent;
- Jim toggles into private mode while a session is attached (user-initiated — the session is ended with a neutral reason, see §4.3);
- an agent deliberately ends after being asked to wrap up;
- an admin marks a session ended in the dashboard/CLI.

Every one of these is an explicit user/admin action, not an inference. Harness reset/new/exit should pause, not end.

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
- end the attached public session (neutral reason) on the public→private transition;
- call The Librarian CLI with consistent flags;
- rate-limit checkpoints;
- normalise source refs/cwd/project keys;
- handle idempotent start/resume/pause.

The shared helper should be dependency-light because it will run in several harness environments.

---

## 7. Harness-specific implementation

### 7.1 Claude Code

#### Commands

Add command file:

```text
integrations/claude-code/.claude/commands/
  lib-toggle-private.md
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

The `lib-toggle-private` command file is a discoverability aid, not the enforcement mechanism. The actual privacy transition (and the public-session end on going private) must be handled by `UserPromptSubmit` or another synchronous local command path before Claude can make Librarian calls. If that hook is unavailable or fails, automatic Librarian startup must be disabled for that turn.

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
| `UserPromptSubmit` | Privacy gate. Detect privacy markers and the toggle command; on entering private with a session attached, end it (neutral reason); update local state before other Librarian hooks run. |
| `SessionStart` | Initialise local state only; start/resume only if a meaningful prompt is available or wrapper policy says to attach immediately. |
| `PostCompact` | Checkpoint if public and attached. |
| `TaskCompleted` | Gated checkpoint if public and attached. |
| `SessionEnd` | Pause if public and attached. |
| `Stop` | No lifecycle mutation by default; optional activity heartbeat. |

Do not depend on hooks exporting `LIBRARIAN_SESSION_ID` back to Claude. Use local state.

### 7.2 Hermes Agent

#### Commands

Add the toggle to the Hermes command parser:

```text
/lib:toggle-private
```

`toggle-private` is handled by Hermes/gateway local state. It is not forwarded to The Librarian, except for the public-session end on the public→private transition.

#### Gateway behaviour

Implement synchronous gateway middleware under:

```text
integrations/hermes/middleware/librarian-lifecycle/
  ...
```

Hermes gateway hooks are useful for non-blocking lifecycle work, but they are not sufficient as the privacy barrier. The toggle command and plain-text marker detection must run in the command/message path before `agent:start` and before any automatic Librarian call. If the middleware cannot evaluate privacy state, it must fail closed and suppress Librarian automation for that message.

Events:

| Hermes event | Action |
|---|---|
| `command:*` | Recognise the local toggle-private command before agent execution. |
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

Codex is **first-class** when hooks are enabled: it ships a real synchronous `UserPromptSubmit` hook that runs *before user input is processed* and can return `{"decision": "block"}` to stop a prompt reaching the model — a genuine pre-agent privacy gate, equivalent to Claude Code's. Codex hooks are gated behind the feature flag (referred to as `codex_hooks` in this spec; the **real Codex config flag is `[features] hooks = true`**, default true) and configured in `hooks.json` or inline in `config.toml`; they are synchronous/blocking and receive JSON on `stdin`.

> **Implementation note (verified against the Codex hooks docs).** Codex's actual event set is `SessionStart`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `Stop` — there is **no `SessionEnd` and no `TaskCompleted`** event. Consequently the integration maps `UserPromptSubmit → handlePrompt`, `PostCompact → checkpoint`, and treats `PreCompact` as a no-op (checkpointing on both would double-fire around one compaction, since the lifecycle treats `compaction` as an always-pass boundary). Pause-on-exit is the wrapper's job, not a hook.

#### Hooks (primary path)

Ship hooks under:

```text
integrations/codex/hooks/librarian/
  user-prompt-submit.py
  session-start.py
  pre-compact.py
  post-compact.py
  stop.py
  pause-idle.py   # optional wrapper/timer helper, not a Codex hook event
```

Mapping (exact Codex event names):

| Codex event | Action |
|---|---|
| `UserPromptSubmit` | Privacy gate. Detect markers / `toggle-private`; on entering private with a session attached, end it (neutral reason) and suppress; keep off-record content out of any Librarian call. |
| `SessionStart` (`startup`/`resume`/`clear`/`compact`) | Initialise local state; start/resume if public and policy allows. |
| `PreCompact` / `PostCompact` | Gated checkpoint if public and attached. |
| `Stop` | Gated checkpoint or heartbeat only. Do **not** pause every turn. |
| Wrapper exit / idle timer | Pause if public and attached. |

Codex matching hooks may run concurrently. Scripts must use file locks around local state updates.

#### Instruction fallback (only when hooks are off)

When `codex_hooks` is not enabled, fall back to a skill + instructions:

```text
integrations/codex/skills/lib-session/SKILL.md
integrations/codex/AGENTS.md
```

covering `/lib:toggle-private` text recognition, private/public phrases, no Librarian calls in private mode, and explicit `agent_id` use once the naming contract lands. This instruction path is **best-effort only** — the model sees the prompt before obeying — so with hooks off, automatic Librarian startup stays disabled and privacy is advertised as best-effort, not guaranteed.

### 7.4 OpenCode

OpenCode is the **one harness with no synchronous pre-prompt hook**. Its plugin API exposes lifecycle, tool, and command events, but nothing that fires before the model processes a *natural-language* message (no `chat.message` / `prompt.before`). The closest is `tool.execute.before` — which gates tool calls, not input. The consequence is direct: **natural-language privacy markers cannot be guaranteed on OpenCode**, so OpenCode auto-start stays disabled and its privacy is best-effort until the gaps below are resolved by a spike.

#### Commands

OpenCode supports custom Markdown commands. Add:

```text
integrations/opencode/.opencode/commands/
  lib-toggle-private.md
```

Retain existing per-verb session commands. Command files are prompt-based, so the toggle's privacy effect must be enforced by the plugin via a command event, not by the prompt expansion.

#### Plugin

Implement lifecycle in a plugin:

```text
integrations/opencode/plugins/librarian-lifecycle.ts
```

Plugins export functions returning a hooks object (`{ [eventName]: async (input, output) => {…} }`); handlers are async and can modify `output` before execution continues. Use these documented events (exact names), subject to a spike:

| OpenCode event | Action |
|---|---|
| `tui.command.execute` / `command.executed` | Detect `/lib-toggle-private`. **Spike must confirm `tui.command.execute` fires *before* the agent runs** — only then is the command-driven toggle a real gate. |
| `session.created` | Initialise local state and attach if public. |
| `session.compacted` | Checkpoint if public and attached. |
| `session.idle` | Pause after configured idle threshold. |
| `session.updated` | Optional activity heartbeat. |
| `tool.execute.before` | Available, but gates tools not input — not a prompt privacy gate. |

There is **no** event for natural-language marker detection, so on OpenCode the §3.3 plain-text markers are best-effort only. The spike must (a) confirm whether `tui.command.execute` is synchronous and pre-agent, and (b) validate the session events fire on the installed version, before OpenCode privacy is advertised as anything more than best-effort.

### 7.5 Pi

Pi is **first-class**. Despite first appearances it has a rich extension system: native TypeScript extensions (loaded via `jiti`, no build step) that receive an `ExtensionAPI`, discovered from `~/.pi/agent/extensions/*.ts`, `.pi/extensions/*.ts` (project-local), or `npm:`/`git:` refs in `settings.json`. Crucially it exposes a real synchronous pre-prompt gate and full session lifecycle events. Docs: https://pi.dev/docs/latest/extensions

#### Extension

Ship a native extension:

```text
integrations/pi/extensions/librarian-lifecycle.ts
```

Privacy gate and lifecycle (exact event names / APIs):

| Pi event / API | Action |
|---|---|
| `input` | **Privacy gate.** Fires after extension commands are checked but *before* skill/template expansion and agent processing. Return `{ action: "handled" }` to swallow off-record input, or `{ action: "transform", text }` to rewrite. Detect markers / the toggle here. |
| `before_agent_start` | Secondary pre-agent point for context decisions if needed. |
| `pi.registerCommand("lib-toggle-private", …)` | Register the toggle natively. |
| `session_start` (`reason: startup\|reload\|new\|resume\|fork`) | Initialise local state; start/resume if public. |
| `session_before_compact` | Gated checkpoint if public and attached. |
| `session_shutdown` | Pause if public and attached. |

#### Packages are not a privacy shortcut

Jim flagged the package repository (e.g. [`pi-yaml-hooks`](https://pi.dev/packages/pi-yaml-hooks), [`@vahor/pi-hooks`](https://pi.dev/packages/@vahor/pi-hooks)). These are fine for *non-privacy* lifecycle convenience, but `pi-yaml-hooks` in particular **cannot** carry the privacy gate: it rejects `command:` actions at load time and exposes only `tool.*` / `session.*` / `file.changed` — it never intercepts user input before the agent. The privacy gate must live in the native extension's `input` handler. Do not wire privacy through a YAML-hooks package and assume it is safe.

### 7.6 Distribution & installation (marketplaces)

Installation should be as close to one-click as each harness allows. Where a harness has a marketplace or package registry, **publish there**. Regardless of channel, every package must bundle the **`use-the-librarian` skill** (`skills/use-the-librarian/SKILL.md`) alongside the commands / hooks / extension / plugin **and** the MCP server registration, so a single install yields everything at once: the MCP connection, the session + `toggle-private` commands, the lifecycle gate, and the skill that teaches the agent how to use it. Installing the plumbing without the skill is not a complete install.

| Harness | Channel | One package bundles | User install |
|---|---|---|---|
| **Claude Code** | Plugin marketplace (`.claude-plugin/marketplace.json`) | commands + hooks + skill + MCP server — all in one plugin | `/plugin marketplace add <org>/librarian-marketplace`, then `/plugin install librarian@<marketplace>` |
| **Codex** | Plugin marketplace (`/plugins` browser) | skill + MCP server in the plugin; lifecycle hooks ship as a companion bundle | Install from `/plugins`; enable `codex_hooks` and add the hooks bundle |
| **Pi** | npm, auto-indexed by pi.dev/packages (no submission step) | native extension (`input` gate + lifecycle) + registered command + skill | `pi install npm:@the-librarian/pi` (or a `git:` ref) |
| **OpenCode** | npm + `opencode.json` `"plugin"` (ecosystem listing; no formal marketplace) | plugin (npm) + command files + skill | add the npm plugin to `opencode.json` `"plugin"`; package installs the commands + skill |
| **Hermes** | First-party gateway (no marketplace) | gateway middleware + commands + skill | enabled in gateway config/deploy |

Specifics:

- **Claude Code** is the cleanest target: a single plugin carries `commands/`, `hooks/hooks.json`, `skills/use-the-librarian/`, and the MCP server (`.mcp.json` or `mcpServers` in `plugin.json`), referencing bundled files via `${CLAUDE_PLUGIN_ROOT}`. Ship a Librarian marketplace repo; optionally submit to the community marketplace (`anthropics/claude-plugins-community`). Run `claude plugin validate` before publishing.
- **Codex** plugins bundle skills + MCP but **not** hooks/commands, so the plugin delivers the skill + MCP connection while the lifecycle hooks ship as a companion bundle enabled with `codex_hooks` (§7.3). List the plugin in the Codex `/plugins` marketplace.
- **Pi** publishes the native extension as a package so one `pi install` pulls the `input`-gate extension, the registered command, and the skill. Discovery is automatic, not gated: publish to npm with `"keywords": ["pi-package"]` and a `pi` manifest listing `extensions` + `skills`, and the package appears in the pi.dev/packages gallery — no submit/approval flow. Do **not** route privacy through a `pi-yaml-hooks` package (§7.5).
- **OpenCode** has no first-class marketplace today: ship an npm plugin referenced from `opencode.json` `"plugin"`, with the command markdown files and skill installed by the package. Keep auto-start disabled until the privacy spike clears (§7.4).
- **Hermes** is first-party — no marketplace; the middleware, commands, and skill deploy with the gateway.

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

The `toggle-private` command updates local state directly; its only Librarian call is ending the attached public session (via this CLI) on the public→private transition.

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
- entering private while a session is attached ends that session with a neutral reason, then makes no further calls;
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

- `/lib:toggle-private` is handled locally and not forwarded to The Librarian (except the public-session end on the public→private transition);
- privacy handling runs in synchronous middleware, not only in a non-blocking hook;
- Discord `source_ref` includes channel and thread where available;
- long-thread attach chooses active/paused sessions only.

Codex:

- with `codex_hooks` enabled, `UserPromptSubmit` gates off-record prompts (returns `decision: block`);
- hooks respect `codex_hooks` feature flag configuration;
- without hooks enabled, privacy is marked best-effort and auto-start remains disabled;
- `Stop` does not pause every turn;
- file locking prevents concurrent hook state corruption.

OpenCode:

- command files appear in command list;
- plugin receives expected session events on the installed version;
- spike confirms whether `tui.command.execute` fires before the agent (gate) or after (best-effort only);
- natural-language markers are documented as best-effort (no pre-prompt hook);
- `session.compacted` checkpoints; `session.idle` pauses after threshold.

Pi:

- the `input` handler swallows off-record prompts (`action: handled`) and rewrites where needed (`action: transform`);
- `session_start` / `session_before_compact` / `session_shutdown` map to start / checkpoint / pause;
- `pi.registerCommand` exposes `/lib-toggle-private`.

### 11.3 Manual smoke tests

For each implemented harness:

1. Start a normal task; verify a Librarian session starts or resumes.
2. With a session active, say “this is a private session”; verify the session is ended with a neutral reason and no further Librarian calls occur.
3. Say “you can remember again”; verify public behaviour resumes.
4. Trigger compaction/task completion where possible; verify checkpoint quality.
5. Exit/reset/idle; verify pause, not end.

---

## 12. Rollout plan

1. Add shared privacy contract to all integration instruction files.
2. Implement shared local state/privacy helper.
3. Implement Claude Code toggle-private command and hooks.
4. Implement Hermes gateway toggle-private handling and lifecycle pause/checkpoint.
5. Implement Codex hooks (first-class when `codex_hooks` enabled); ship the skill/instruction fallback for hooks-off.
6. Implement the Pi native extension (`input` gate + session lifecycle events).
7. Spike OpenCode: confirm whether `tui.command.execute` is a pre-agent gate and that session events fire; implement the plugin, but keep auto-start disabled and natural-language privacy best-effort until the spike clears it.
8. Package each integration for its marketplace/registry (Claude Code plugin, Codex plugin, Pi package, OpenCode npm plugin, Hermes gateway bundle), each bundling the `use-the-librarian` skill (§7.6).
9. After one week of use, review session noise and checkpoint quality before increasing automation.

---

## 13. Success criteria

- [ ] Every harness integration documents the zero-interaction private rule.
- [ ] Harnesses with command support expose the `/lib:toggle-private` control.
- [ ] Plain-text private markers are detected before normal Librarian calls where synchronous hooks/gateway/wrappers support it.
- [ ] Harnesses without a pre-agent privacy gate do not enable automatic Librarian startup.
- [ ] Private mode suppresses sessions and memories.
- [ ] First meaningful public interaction can start/resume a session automatically.
- [ ] Compaction/task boundaries create useful checkpoints where supported.
- [ ] Exit/reset/idle pauses sessions, not ends them.
- [ ] Entering private mode while a session is attached ends it with a neutral reason.
- [ ] No v1 automation auto-ends a session by heuristic (the only end triggers are explicit: `/lib:session end`, an agent wrap-up, an admin action, or the user toggling into private mode).
- [ ] Hook scripts/plugins use local state rather than environment-only state.
- [ ] Automation is idempotent and safe under retries.
- [ ] Each harness integration installs via its marketplace/registry where one exists, bundling the `use-the-librarian` skill with the commands/hooks/extension/plugin and the MCP registration.

---

## 14. Explicit non-goals

- No raw transcript capture.
- No server-side filtering as the main privacy mechanism.
- No auto-end heuristics in v1.
- No reliance on natural-language privacy markers on OpenCode until a pre-agent gate is proven (it has no pre-prompt hook today).
- No memory-curator behaviour in this spec; that is separate.

---

## 15. Open questions

1. ~~Command form~~ **Resolved:** a single local command, canonical `/lib:toggle-private` (rendered `/lib-toggle-private` by file-named harnesses); directional natural-language markers remain the unambiguous enter-privacy path.
2. Idle threshold before auto-pause — default **6 hours**, configurable (§5.3/§10); revisit against real Discord usage after a week.
3. ~~Hermes state persistence~~ **Resolved:** persist enough local state to survive gateway restarts (§4.2).
4. ~~Codex opt-in~~ **Resolved:** Codex is first-class when `codex_hooks` is enabled; instruction-only fallback (auto-start off) when it is not.
5. ~~OpenCode Tier 1~~ **Resolved:** not yet — OpenCode has no pre-prompt hook, so it stays best-effort/spike-gated; promote only if the spike proves `tui.command.execute` is a pre-agent gate.

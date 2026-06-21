# Harness Commands, Private Mode, and Session Lifecycle — Research

> **Superseded by the spec.** This is the original research/exploration doc. The implemented design lives in [`docs/specs/done/012-harness-commands-and-lifecycle-spec.md`](../specs/harness-commands-and-lifecycle-spec.md); the build followed [`docs/specs/done/014-implementation-plan.md`](../specs/implementation-plan.md). Where this doc and the spec disagree, the spec wins. Kept for provenance — read the spec for current behaviour.

**Author:** Guybrush
**Date:** 2026-05-23
**Status:** Research — superseded by `docs/specs/done/012-harness-commands-and-lifecycle-spec.md`

---

## 1. Executive conclusion

The Librarian needs two related but separate improvements:

1. **Privacy/off-record controls.** Guybrush needs a reliable way to say “this is private”, “don’t remember this”, “off the record”, or use a harness command/flag, and have that disable both session storage and memory writes.
2. **Lifecycle automation.** Sessions are currently mostly manual. Harness integrations should start, checkpoint, pause, and resume sessions automatically where the harness makes that safe.

The most important research finding is that privacy cannot be enforced only by the agent’s good intentions. If an agent calls `start_context` before reading the user’s “this is private” sentence, the system has already broken the rule. The privacy gate has to sit **before normal Librarian calls**, preferably in harness command handling, prompt-submit hooks, gateway middleware, or wrapper scripts. Prompt-only commands/instructions are useful reminders, but they do not provide the zero-call guarantee.

For lifecycle, the right v1 posture is conservative:

- auto-start or resume on the first non-private meaningful interaction;
- auto-checkpoint at high-value boundaries such as compaction, explicit task completion, or substantial work;
- auto-pause on exit, reset, long idle, or handoff;
- **do not auto-end**. Guybrush often has long breaks in conversations that continue over days. “End” is a semantic decision and should remain explicit for now.

---

## 2. Privacy model

### 2.1 What “private” means

For this design, private/off-record mode means **zero interaction with The Librarian**:

- no `start_context`;
- no `recall`;
- no `start_session`;
- no session events;
- no `remember` or `propose_memory`;
- no checkpoint, pause, continue, or end calls;
- no metadata stored in The Librarian saying a private session existed.

This is stronger than `agent_private` visibility. `agent_private` is still stored. Off-record private mode is not stored at all.

### 2.2 Privacy triggers

The system should recognise both command and natural-language forms.

| Trigger | Examples | Enforcement point |
|---|---|---|
| Harness command | `/lib:session private`, `/lib-session-private`, `/private` where supported | Native command handler or prompt-submit hook before agent work |
| Start flag | `/lib:session start --private`, harness wrapper `--private` | Wrapper or command parser before any Librarian call |
| Plain text | “this is a private session”, “don’t remember this”, “off the record”, “don’t save anything from this conversation” | Prompt-submit/gateway/wrapper gate where available; otherwise best-effort agent instruction only |
| End private mode | “you can remember again”, “end private mode”, `/lib:session public` | Local harness privacy state only; first public interaction may then start/resume Librarian use |

Plain-text detection should be conservative and focused on explicit phrases. We do not want ordinary phrases such as “privately I think…” to accidentally disable memory for a long run.

If a private marker and substantive content appear in the same prompt, treat the whole prompt as private. If an exit-private marker and substantive content appear in the same prompt, apply the local mode change but resume public Librarian behaviour only from the next prompt.

### 2.3 Local-only privacy state

Private mode state must be local to the harness/integration, not stored in The Librarian. Examples:

- process environment variable for wrapper-managed runs;
- local state file under the harness config directory;
- gateway in-memory/session state for Hermes;
- OpenCode plugin state;
- Claude/Codex hook state keyed by harness session id.

The state should store only the fact that this local harness session is in private mode. It should not store the private prompt text.

### 2.4 Existing active sessions

The awkward case is a public session already exists, then Guybrush says “this next bit is private”. The correct behaviour is:

1. detect the marker;
2. stop all future Librarian calls immediately;
3. do **not** pause/checkpoint/end the existing Librarian session, because that call itself would create evidence of the private boundary;
4. keep the local session id dormant;
5. when Guybrush explicitly exits private mode, start a new public session by default unless he explicitly resumes the old public session.

This means the stored public Librarian session may remain active longer than reality. That is acceptable. Privacy beats lifecycle neatness.

---

## 3. Lifecycle model

The current manual model has the right primitives but too much human bookkeeping. The automation layer should not invent new session states; it should call the existing lifecycle operations at better times.

### 3.1 Recommended semantics

| Event | Recommended action | Reasoning |
|---|---|---|
| First non-private meaningful interaction | Start or resume a Librarian session | Removes manual setup burden. |
| Existing resumable session for same source/project | Resume/continue rather than start | Long threads often span days. |
| Context compaction | Checkpoint | Captures state before context is lost. |
| Explicit task completion or substantial work | Checkpoint | Good balance of useful evidence vs noise. |
| Harness process exit/reset/idle | Pause | The work may resume later; do not end. |
| Explicit user `/lib:session end` | End | User/agent has decided the bounded work is done. |
| Private mode detected | No Librarian action | Zero interaction rule. |

### 3.2 Why auto-end is risky

“End” sounds easy in short CLI sessions, but Guybrush’s actual usage includes:

- Discord threads that continue for days;
- long breaks between messages;
- switching between harnesses mid-task;
- revisiting old context after a pause.

An automatic end would frequently be wrong, and it would turn a resumable session into historical evidence prematurely. In v1, use auto-pause. Add auto-end later only if there is a strong, explicit signal, such as a user command or maybe a very long retention policy reviewed by Guybrush.

### 3.3 Start vs resume

Automation should prefer “attach to an existing resumable session” when there is a clear match:

- same `source_ref` for messaging surfaces;
- same `cwd`/project for coding harnesses;
- same harness session id if available;
- status `active` or `paused`, not `ended` unless the user explicitly resumes it.

If several candidates exist, do not guess silently. Use the normal list-and-select flow when the user is present, or start a new session with a clear start summary when unattended.

---

## 4. Harness survey

### 4.1 Claude Code

**Command support: strong.** Claude Code supports custom slash commands via command files. The existing Librarian integration already uses per-verb commands for the session lifecycle. It should add private/public commands.

**Lifecycle support: strongest.** Claude Code’s hook system includes session-level, turn-level, tool-level, compaction, and task events. Relevant events from the official hook docs include `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreCompact`, `PostCompact`, `TaskCompleted`, and `Stop`.

**Important implementation caveat:** hook scripts cannot reliably `export LIBRARIAN_SESSION_ID` into a parent process that already exists. Hooks should use a local state file keyed by Claude session id / cwd / project. A wrapper can export env vars before launching Claude; hooks should not depend on that as their only state mechanism.

**Best v1 use:**

- `UserPromptSubmit` detects privacy markers before normal work;
- `SessionStart` starts/resumes only if not private;
- `PostCompact` checkpoints;
- `TaskCompleted` checkpoints if enough changed;
- `SessionEnd` pauses;
- `Stop` is usually too frequent for lifecycle changes; use it only as a low-cost heartbeat or to mark “work happened”.

Claude command files should be treated as discoverability aids. The privacy state transition must happen in `UserPromptSubmit` or another synchronous local path before Claude can make Librarian calls.

**Priority:** first. Claude Code has the richest event model and command surface.

Sources: Claude Code hooks reference, `https://code.claude.com/docs/en/hooks`.

### 4.2 Hermes Agent

**Command support: strong.** Hermes already supports the canonical `/lib:session <verb>` surface in Guybrush’s environment. It is also the primary Discord/gateway surface.

**Lifecycle support: strong, but different.** Hermes has gateway hooks (`HOOK.yaml` + `handler.py`), shell hooks, and plugin hooks. The relevant gateway events include `session:start`, `session:end`, `session:reset`, `agent:start`, `agent:end`, and `command:*`.

Gateway hooks are non-blocking. That is good for lifecycle reliability but means a hook failure must not be the privacy barrier. Privacy commands and prompt gating should happen in synchronous gateway command/message middleware before agent execution and before any automatic Librarian start. If that middleware cannot read/write local privacy state, fail closed and suppress Librarian automation for the message.

**Best v1 use:**

- native `/lib:session private` command toggles local gateway privacy state;
- gateway message pre-processing detects explicit natural-language privacy markers;
- first non-private agent run starts/resumes a session keyed by Discord channel/thread `source_ref`;
- `agent:end` checkpoints only when there were meaningful tool calls or a task summary;
- `session:end`/`session:reset` pauses, not ends.

**Priority:** second, because this is Guybrush’s live Discord surface.

Sources: Hermes Agent hooks docs, `https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks`.

### 4.3 Codex

**Command support: partial.** Codex has built-in slash commands and skills, but the official CLI/app command docs do not show a Claude-style project directory for arbitrary custom slash commands. Codex skills may improve discoverability, and enabled skills appear in command/skill surfaces, but relying on exact `/lib-session-start` style commands is not safe today.

**Lifecycle support: usable but beta.** Codex hooks are behind a feature flag (`codex_hooks = true`). Official docs show `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, and `Stop`. Matching hooks from multiple files all run, and matching command hooks for the same event run concurrently.

**Critical caveat:** `Stop` fires at turn scope. Auto-pausing on every `Stop` would make sessions flap active/paused after every response and would create noisy lifecycle evidence. Use `Stop` for checkpoint/heartbeat only when work changed materially, not for pause. Use a wrapper/process-exit path or idle timer for pause.

**Best v1 use:**

- `UserPromptSubmit` detects privacy markers;
- `SessionStart` starts/resumes only if not private;
- `Stop` records local “activity happened” and maybe triggers a gated checkpoint;
- wrapper exit or idle timer pauses;
- improve AGENTS.md/skill instructions for text command detection.

Codex AGENTS/skill instructions are best-effort only. For the zero-call guarantee, Codex needs the `UserPromptSubmit` hook or a wrapper that gates prompts before agent execution. Until then, automatic Librarian startup should be disabled by default in Codex.

**Priority:** third. Worth doing, but behind a feature flag and less rich than Claude/Hermes.

Sources: Codex hooks docs `https://developers.openai.com/codex/hooks`; Codex CLI slash commands `https://developers.openai.com/codex/cli/slash-commands`; Codex app commands `https://developers.openai.com/codex/app/commands`.

### 4.4 OpenCode

**Command support: strong.** OpenCode supports custom commands via JSON config or Markdown command files in `.opencode/commands/` or `~/.config/opencode/commands/`. The command body becomes a prompt; command files support arguments, file references, and shell output injection.

**Lifecycle support: viable through plugins.** Earlier drafts treated OpenCode as having no lifecycle support because older feature requests asked for Claude-style hooks. The current docs show a plugin system with events including `command.executed`, `session.created`, `session.compacted`, `session.idle`, `session.status`, `session.updated`, `tool.execute.before/after`, and TUI command events.

This is not the same as a simple declarative hook file. It requires writing and installing a JavaScript/TypeScript plugin. But it is enough for v1 lifecycle automation if the event semantics behave as documented.

**Best v1 use:**

- custom commands for `/lib-session-*`, including private/public;
- plugin intercepts command/prompt events for privacy markers;
- `session.created` starts/resumes when non-private;
- `session.compacted` checkpoints;
- `session.idle` pauses after a threshold;
- plugin state tracks the Librarian session id.

OpenCode command files may also be prompt-based. They need the plugin/pre-agent path for guaranteed privacy; without it, private commands are discoverability only and automatic Librarian startup should remain off.

**Priority:** fourth, but no longer “wait for upstream”. Build after Claude/Hermes/Codex unless Guybrush starts using OpenCode heavily.

Sources: OpenCode commands docs `https://opencode.ai/docs/commands`; OpenCode plugins docs `https://opencode.ai/docs/plugins`; OpenCode skills docs `https://opencode.ai/docs/skills`; older feature request context `https://github.com/anomalyco/opencode/issues/573`.

### 4.5 Pi

**Command support: unknown/weak.** There is no stable public command model in the material reviewed. Treat it as text-based only.

**Lifecycle support: unknown.** Do not design a concrete Pi implementation until the runtime interface is real enough to test.

**Best v1 use:**

- integration instructions only;
- agent must recognise `/lib:session` and private markers in text;
- no automatic lifecycle beyond whatever wrapper exists.

Pi text instructions are best-effort only. Do not enable automatic Librarian startup until there is a wrapper or runtime hook that can gate privacy before the agent runs.

**Priority:** last.

---

## 5. Summary matrix

| Harness | Commands | Privacy pre-gate | Lifecycle automation | v1 priority |
|---|---|---|---|---|
| Claude Code | Native custom commands | `UserPromptSubmit` hook + private command | Rich hooks: start, end, compact, task | 1 |
| Hermes Agent | Native `/lib:session` | Gateway command/message handling | Gateway hooks/events | 2 |
| Codex | Built-ins + skills; text fallback | `UserPromptSubmit` hook or wrapper; otherwise best-effort only | Beta hooks + wrapper/idle pause | 3 |
| OpenCode | Native custom commands | Plugin command/prompt events; commands alone are not enough | Plugin session events | 4 |
| Pi | Text fallback | Agent instruction only, not a guarantee | Unknown | 5 |

---

## 6. Implementation themes

### 6.1 Local state, not environment-only state

Environment variables are useful for wrappers but insufficient for hooks that run after the harness process exists. Every integration needs a local session-state abstraction:

```json
{
  "harness": "claude-code",
  "harness_session_key": "...",
  "source_ref": "...",
  "cwd": "...",
  "project_key": "...",
  "librarian_session_id": "ses_...",
  "privacy": "public|private",
  "last_activity_at": "...",
  "last_checkpoint_at": "..."
}
```

This file lives outside The Librarian and must not contain private prompt content. Store it with `0700` directory permissions and `0600` file permissions; if state cannot be read or written, fail closed and skip automatic Librarian calls.

### 6.2 Idempotency

Hooks may fire more than once, concurrently, or after retries. Lifecycle scripts must be idempotent:

- starting twice should reuse the same local attached session or discover a matching resumable session;
- pausing an already paused session should be harmless;
- checkpoints should be rate-limited and content-hash deduped;
- private mode should short-circuit before any network/CLI call.

### 6.3 Checkpoint quality gates

Automatic checkpointing can be worse than manual checkpointing if it records “did some stuff” noise. Gates should include at least one of:

- compaction occurred;
- task completed event with a summary;
- files changed since last checkpoint;
- commands/tools run above a threshold;
- elapsed time since last checkpoint and new activity;
- explicit agent summary available.

### 6.4 No server-side privacy cleanup

The server can and should reject direct attempts to store memory while a caller declares private mode, if such a flag ever reaches it. But the primary guarantee cannot be “filter later”. The goal is no call at all.

---

## 7. Open questions

1. What exact private/public command names does Guybrush want exposed per harness? `/lib:session private` is canonical, but per-harness aliases may be useful.
2. How aggressive should plain-text privacy detection be? A small phrase list is safer than a fuzzy classifier.
3. Should auto-start happen at harness session start or first meaningful user prompt? First prompt is safer because an idle shell opening should not create a session.
4. What idle threshold should trigger pause in long-running chat surfaces? Hours, not minutes, seems right for Discord.
5. Should reset/new pause or end? This research recommends pause in v1.
6. Should the fresh-session-after-private default ever be relaxed for same-topic conversations, or should reuse always require explicit user confirmation?

---

## 8. Recommended v1 plan

1. Add the privacy contract to every integration instruction file.
2. Add native private/public commands where the harness supports them.
3. Build a shared local state/helper library for harness scripts/plugins.
4. Implement Claude Code privacy + lifecycle hooks first.
5. Implement Hermes gateway privacy + lifecycle second.
6. Implement Codex hooks conservatively: prompt-submit privacy, session-start attach, gated stop checkpoint, wrapper/idle pause.
7. Implement OpenCode plugin after validating event payloads in a spike.
8. Leave Pi as text-based instructions until its runtime settles.

This gives Guybrush privacy safety first, then removes the worst manual session bookkeeping without pretending “end” is easier than it is.

# Spec: opencode Plugin — Conv-State Injection

**Author:** Claude, with Jim
**Date:** 2026-05-27
**Status:** Draft v1 — investigation phase; design pinned to whatever opencode's SDK surfaces

---

## 1. Purpose

[`memory-domain-isolation-and-conv-state.md`](./memory-domain-isolation-and-conv-state.md) §4.9 defines a per-turn hook contract: every harness integration injects a `<conversation-state>` block ahead of each user message so the LLM sees the current `domain` / `session_id` / `off_record` on every turn — defeating context-compaction-driven state loss.

Three of the five Librarian plugins already implement this (Claude Code, Hermes, Codex — landed in the recent rollout). The remaining two — `the-librarian-opencode-plugin` and `the-librarian-pi-extension` — use hook models that don't trivially map to the §4.9 contract, and were deferred with a note. This document closes the deferral for opencode.

---

## 2. Non-goals

- **Not redefining the §4.9 contract.** The rendered block is byte-identical across all five plugins (`renderConvStateBlock` in `@librarian/core` is the canonical source). This spec adapts the *injection mechanism* to opencode's SDK, not the *payload*.
- **Not changing what `conv_state_get` returns.** The MCP surface (PR 2) is the same for every plugin.
- **Not introducing a new opencode-specific Librarian feature.** This is a parity-with-Claude-Code piece of work, scoped to the existing contract.
- **Not refactoring the opencode plugin's existing hook handlers.** The conv-state injection rides alongside the existing privacy gate and session-bootstrap flow.

---

## 3. Background

### 3.1 What works in the other three plugins

| Plugin | Hook event | Mechanism |
|---|---|---|
| Claude Code | `UserPromptSubmit` | Stdout JSON envelope: `{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "..."}}` |
| Codex | `UserPromptSubmit` | Same envelope shape (Codex models its hook protocol on Claude Code's) |
| Hermes | `prefetch(query)` Memory Provider method | Return-value concatenation — Hermes appends the provider's return string into the model's context |

Each lets the integration add text to the model's context without modifying the user's literal prompt. The conv-state block sits alongside any recall results and the LLM reads both.

### 3.2 What opencode exposes

From the existing plugin handler at `the-librarian-opencode-plugin/src/handlers/chat-message.ts`:

> opencode's `chat.message` hook fires when a new user message is received, with a **mutable `output.message`** — meaning it runs BEFORE the LLM sees the prompt.

This is structurally different. The opencode hook signature implies the integration *mutates* `output.message` rather than *returns context to concatenate*. Prepending the conv-state block to `output.message.text` would change what the user "said" from the LLM's perspective — which is wrong both semantically (the user didn't say it) and from a UX point of view (it could appear in the rendered conversation).

The deferral note in the autonomous-build artefact reads:

> opencode's `chat.message` hook fires with a mutable `output.message`, not a `hookSpecificOutput.additionalContext` envelope. Injection would have to prepend to the user's message text, which changes what the user sees as their prompt — different semantics from the §4.9 contract.

The right answer is almost certainly somewhere else in opencode's SDK — a system-prompt hook, a tool-call-before hook, a separate "augment context" surface. The first phase of this spec is to find it. The second phase is to implement against it.

---

## 4. The contract

### 4.1 Phase A — investigation (mandatory pre-work)

Goal: identify, in opencode's public SDK + extension docs, the hook that lets an integration add text to the LLM's prompt context **without** mutating the user's literal message.

Tasks (in order; each is a single PR-equivalent against this spec, not against code):

1. **Read the opencode hook reference.** Document every hook event the integration surface exposes, plus the signature of each.
2. **Walk the existing plugin's handlers** (`src/handlers/`) and the dispatch site (`src/index.ts`). Note every place that already touches model context. The `session-bootstrap` and `chat-message` handlers are the most relevant.
3. **Specifically look for, in this priority order:**
   - A `before-message-to-model` / `system-prompt-build` / `augment-context` hook that takes additive text.
   - A system-prompt-block API that contributes a frozen string to every turn (cheap-but-stale; same shape as Hermes' `system_prompt_block`).
   - A tool-call hook that fires before each LLM round and can prepend a hidden system message.
   - A "side-channel context" API distinct from the user message.
4. **Confirm with a 20-line spike** in a throwaway opencode plugin: emit a known string via the candidate mechanism and verify the LLM reads it without it appearing in the user-visible transcript.
5. **Update this spec's §4.2 with the chosen mechanism and the spike's evidence.** No code lands in the plugin until §4.2 is filled in.

If no such surface exists in opencode today, the outcome of Phase A is a small upstream feature request to opencode and a documented "blocked on upstream" status for this spec — not a "let's prepend to the user message anyway" compromise.

### 4.2 Phase B — design (filled in after Phase A)

*Placeholder. Populated by Phase A.*

Expected shape (subject to the investigation):

- **Hook event:** `<TBD — likely a system-prompt or before-completion hook>`.
- **Mechanism:** call `conv_state_get` against the configured Librarian endpoint (via the existing `src/mcp-client.ts`), parse the JSON state, render the canonical block via the family-wide helper, return it via whatever path the chosen hook expects.
- **Conv-id derivation:** `opencode:<session-id>` where `<session-id>` is opencode's `input.sessionID` (which the existing handlers already capture; see `chat-message.ts` `ChatMessageInput`).
- **Privacy gating:** unchanged — the existing off-record flag suppresses the call entirely, mirroring the other plugins.
- **Fail-soft:** unchanged — any error (network, parse, missing config) returns the no-op response; the LLM never sees a stack trace.

### 4.3 Conv-id convention

`opencode:<sessionID>` where `<sessionID>` is `input.sessionID` as passed to `chat.message`. This matches the prefix convention from spec §4.8 (`claude:<id>`, `codex:run:<id>:cwd:<path>`, `hermes:<id>`). Documented here so it's set before Phase A picks the mechanism — the conv-id is the same regardless of which hook we wire it to.

### 4.4 Privacy + fail-soft contracts (binding from Phase A onward)

These come from the plugin's AGENTS.md and the parent spec. They are non-negotiable in any Phase B design:

- **No MCP call while off-record.** The plugin's existing `privacy-detector.ts` + `state-store.ts` gate every Librarian call; the conv-state injection adopts the same gate.
- **Fail-soft on every error path.** Network, parse, schema, model-unavailable, missing-token, missing-endpoint — all of them return the no-op response.
- **Sub-second budget.** Whatever opencode hook we wire into, the conv-state lookup must complete in under 500ms or the turn proceeds without injection. The block matters less than the turn.

### 4.5 What we won't do

- Mutate `output.message.text` to inject context. This is explicitly off the table: it would surface in the user-visible transcript and corrupt the conversation log.
- Inject via a tool-call that masquerades as a recall. The block is *state*, not a memory; rolling it into the recall surface would conflate two distinct things.
- Add a new "system prompt" config that ships the block as part of the plugin's static config. That would be stale by design — the whole point of the contract is that the block reflects *current* registry state, recomputed every turn.

---

## 5. Tech stack

- **Plugin repo:** `the-librarian-opencode-plugin` (TypeScript, `bun` toolchain, `src/handlers/` layout).
- **New runtime deps:** none anticipated. The plugin already has an MCP client (`src/mcp-client.ts`) and a privacy gate.
- **Family-wide block renderer:** the canonical block format is the contract; we replicate the renderer locally (consistent with the AGENTS.md "five peer implementations" rule) rather than depending on `@librarian/core`.

---

## 6. Decisions

- **D1.** Investigation-first. No code lands until the opencode hook surface for additive context is identified and demonstrated by spike.
- **D2.** Never mutate `output.message`. The conv-state block belongs in a side-channel, not in the user's apparent message.
- **D3.** Conv-id convention: `opencode:<sessionID>`. Set now, independent of the hook we land on.
- **D4.** Privacy gate, fail-soft, sub-500ms budget — all binding, all from existing house rules.

---

## 7. Migration / rollout

One PR in the plugin repo, contingent on Phase A producing a workable mechanism:

1. Land Phase A as documentation only (this spec's §4.2 filled in, plus a short spike report committed alongside).
2. PR the implementation: new handler under `src/handlers/`, wired into `src/index.ts`'s dispatch table.
3. Tests: the existing test layout in `tests/` already has handler-level coverage; mirror the pattern (4 cases — hit, miss, throw, off-record).
4. CHANGELOG entry under `## [Unreleased]`.

No user-facing migration. Existing users keep running the current plugin; the next release ships injection.

---

## 8. Success criteria

- [ ] Phase A produces a named opencode hook + a 20-line spike showing the LLM reads injected text that is not in the visible transcript.
- [ ] The implementation renders the canonical `<conversation-state>` block byte-identically with the other four plugins (regression-tested against the family contract).
- [ ] `conv_state_get` is called at most once per user turn (no duplicate fetches under retries or reconnects).
- [ ] Off-record state suppresses every Librarian call for the turn.
- [ ] A Librarian outage produces no stack trace, no blocked turn, no visible artefact in the transcript.
- [ ] Adding a second domain to a fresh install and seeding a `conv_state` row makes the next opencode turn carry the canonical block; clearing the row makes the following turn carry nothing.

---

## 9. Open questions

- **Does opencode have a "system prompt fragment" hook?** This is the unknown that gates the whole spec. The investigation in §4.1 answers it.
- **If not — is there an upstream PR worth opening?** Could plausibly be a 20-line change in opencode itself if the hook genuinely doesn't exist. Lower-priority alternative to a workaround.
- **Should `is_global` filtering be visible to opencode plugins?** Not in this spec, but worth raising: the §4.11 hard filter on `recall` is server-side and uniform across all integrations. opencode users get domain isolation for free once the injection is in place.
- **Pi extension parity.** The sibling spec [`pi-extension-conv-state-injection-spec.md`](./pi-extension-conv-state-injection-spec.md) faces a similar investigation; useful to do both in the same week so we can share any opencode/pi SDK conventions we learn.

# Spec: opencode Plugin — Conv-State Injection

**Author:** Claude, with Jim
**Date:** 2026-05-27
**Status:** Draft v2 — Phase A investigation complete; hook identified as `experimental.chat.system.transform`; design ready for implementation

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

### 4.1 Phase A — investigation findings

Phase A was completed on 2026-05-27 against opencode SDK version 1.15.10 (the version pinned in the plugin's `package.json`).

**The hook surface is `experimental.chat.system.transform`.** Defined in `@opencode-ai/plugin/dist/index.d.ts` lines 264-269:

```typescript
"experimental.chat.system.transform"?: (input: {
    sessionID?: string;
    model: Model;
}, output: {
    system: string[];
}) => Promise<void>;
```

**How it works:** opencode assembles the system prompt internally, then calls every registered plugin's `experimental.chat.system.transform`, giving each plugin a chance to mutate the `output.system` array — adding, removing, or replacing entries. The host then concatenates the array as the LLM's system prompt. Safety fallback documented: if a plugin empties the array entirely, opencode restores the original.

**Cadence:** fires before each LLM call (per-turn), exactly the cadence §4.9 needs to defeat compaction. Confirmed by the existence of in-production plugins using this hook for memory injection (see "Real-world validation" below).

**Type-level spike clean.** A throwaway handler that does `output.system.push(renderConvStateBlock(state))` typechecks cleanly against the SDK types — no signature mismatches, no missing field issues.

**Real-world validation.** Published memory-integration plugins use exactly this hook for the same purpose (see Sources at §10). Specifically: `rohitg00/agentmemory/plugin/opencode` injects a multi-layer context block (project profile, recent session summaries, observations) via `output.system.push(...)` on every turn. That plugin reports operational status against opencode v1.14.41+; our target is the slightly-newer v1.15.10 against which the type signature is unchanged.

**Known issue worth noting (closed-as-not-planned).** [`anomalyco/opencode#17100`](https://github.com/anomalyco/opencode/issues/17100) reports "`experimental.chat.system.transform` silently discards plugin mutations" against the Go binary at an unspecified version. The issue was closed without resolution. The agentmemory plugin's continued operational status suggests the bug, if it exists, is condition-specific rather than the common path; our implementation includes an eyeball-test post-deploy step to confirm injection is reaching the LLM (see §7).

**Why `experimental.chat.messages.transform` was rejected.** The sibling hook (lines 258-263) mutates the entire messages array, which would let us prepend a synthetic system or user message. More invasive than necessary, semantically wrong (the conv-state block is *system* context, not a *message*), and harder to reason about if multiple plugins register transforms in unspecified order.

**Why `chat.params` was rejected.** It mutates temperature / topP / maxOutputTokens, not prompt content. Wrong tool.

### 4.2 Phase B — design

**Hook handler:**

```typescript
// src/handlers/system-transform.ts
import type { Hooks } from "@opencode-ai/plugin";
import type { Deps } from "../deps.ts";
import { renderConvStateBlock } from "../conv-state-render.ts";

const CONV_STATE_TIMEOUT_MS = 500;

export const handleSystemTransform =
  (deps: Deps): NonNullable<Hooks["experimental.chat.system.transform"]> =>
  async (input, output) => {
    // No sessionID → no conv-id → nothing to inject. (Per the SDK type, this
    // field is optional; the hook can fire in contexts without a session.)
    if (!input.sessionID) return;

    // Privacy gate: off-record state suppresses every Librarian call.
    try {
      const state = await deps.loadState();
      if (state.private) return;
    } catch {
      // State unreadable → fail closed (treat as private, no injection).
      return;
    }

    const convId = `opencode:${input.sessionID}`;

    // Fail-soft: any failure leaves system unchanged. The turn proceeds.
    let convState: { conv_id: string; domain: string; session_id: string | null; off_record: boolean } | null = null;
    try {
      convState = await fetchConvStateWithTimeout(deps, convId, CONV_STATE_TIMEOUT_MS);
    } catch (err) {
      await deps.log({ event: "system-transform", outcome: "conv_state_lookup_failed",
                       error: String((err as Error)?.message ?? err) });
      return;
    }

    if (!convState) return;

    output.system.push(renderConvStateBlock(convState));
  };
```

**Wired into the existing dispatch site** (`src/index.ts`) alongside the current `chat.message` handler. No changes to existing handlers.

**Conv-id derivation:** `opencode:${input.sessionID}` — guarded by the `if (!input.sessionID) return` early-out for hook invocations where sessionID is absent.

**Privacy gating:** reuses the plugin's existing `state-store.ts` + privacy detector. Identical guard pattern to the existing `chat-message` handler.

**Fail-soft contracts:**
- Missing sessionID → silent return.
- Off-record → silent return.
- conv_state_get timeout (500ms) → log + silent return.
- conv_state_get network failure → log + silent return.
- conv_state_get parse failure → log + silent return.
- Missing config (no endpoint/token) → silent return.
- `output.system` push throws → propagates back to opencode which has its own safety fallback (the original system array is restored if we somehow empty it).

**Where the renderer lives:** new file `src/conv-state-render.ts`, byte-identical with the other four plugins' implementations (per the AGENTS.md "five peer implementations" rule). Replicates `renderConvStateBlock` locally rather than depending on `@librarian/core`.

**Where the MCP call goes:** the existing `src/mcp-client.ts` already speaks to the Librarian endpoint and is used by the plugin's other Librarian calls. We add a `convStateGet(convId)` helper alongside the existing `recall` / `remember` / session helpers.

### 4.3 What we won't do

- Mutate `output.message.text` to inject context. This is explicitly off the table: it would surface in the user-visible transcript and corrupt the conversation log. (Mentioned for completeness; the chosen hook makes this irrelevant — `output.system` is the right field.)
- Inject via a tool-call that masquerades as a recall. The block is *state*, not a memory; rolling it into the recall surface would conflate two distinct things.
- Add a new "system prompt" config that ships the block as part of the plugin's static config. That would be stale by design — the whole point of the contract is that the block reflects *current* registry state, recomputed every turn.
- Use `experimental.chat.messages.transform` instead of `experimental.chat.system.transform`. The messages hook would let us prepend a synthetic system or user message but it's more invasive than needed and harder to reason about with multiple plugins registered.

---

## 5. Tech stack

- **Plugin repo:** `the-librarian-opencode-plugin` (TypeScript, `bun` toolchain, `src/handlers/` layout).
- **New runtime deps:** none anticipated. The plugin already has an MCP client (`src/mcp-client.ts`) and a privacy gate.
- **Family-wide block renderer:** the canonical block format is the contract; we replicate the renderer locally (consistent with the AGENTS.md "five peer implementations" rule) rather than depending on `@librarian/core`.

---

## 6. Decisions

- **D1.** Hook surface is `experimental.chat.system.transform`. Identified in Phase A; confirmed by type-level spike + published in-production usage (rohitg00/agentmemory).
- **D2.** Never mutate `output.message`. The conv-state block belongs in `output.system`, not in the user's apparent message.
- **D3.** Conv-id convention: `opencode:<sessionID>`.
- **D4.** Privacy gate, fail-soft, sub-500ms budget — all binding, all from existing house rules.
- **D5.** Local renderer (`src/conv-state-render.ts`) rather than a `@librarian/core` dependency. Five peer implementations, no canonical source — same as the other four plugins.
- **D6.** Despite being in the `experimental.*` namespace, the hook is the right choice for V1. Real plugins ship with it; the type signature is stable across the recent SDK minor versions; the alternative would be waiting for opencode to graduate it to a stable namespace (no announced timeline). We accept the risk that opencode could break the surface in a major version and commit to tracking it — see §7.1 for the monitoring plan.

---

## 7. Migration / rollout

One PR in the plugin repo. Phase A is now closed (§4.1 evidence committed; §4.2 design ready).

1. **Create the handler + supporting modules:**
   - `src/handlers/system-transform.ts` — the new hook implementation.
   - `src/conv-state-render.ts` — the family-canonical block renderer (byte-identical with peer plugins).
   - Extend `src/mcp-client.ts` with `convStateGet(convId)` alongside the existing tool helpers.
2. **Wire into the dispatch site** (`src/index.ts`) alongside the existing `chat.message` handler. No changes to existing handlers.
3. **Tests** (`tests/system-transform.test.ts`): four cases mirroring the codex / hermes pattern — state hit prepends the block; no state → silent; conv_state_get throws → silent; off-record → no MCP call at all.
4. **Eyeball-test post-deploy** to confirm injection reaches the LLM. Given the unresolved [#17100 silent-discard issue](https://github.com/anomalyco/opencode/issues/17100) (closed-as-not-planned), the eyeball test is non-negotiable for the first deploy: in a real opencode session against a Librarian with a seeded conv_state row, ask the LLM "what domain are you in?" — if it can answer correctly, injection is working; if it can't, we hit the documented bug and need to escalate upstream.
5. **CHANGELOG entry under `## [Unreleased]`.**

No user-facing migration. Existing users keep running the current plugin; the next release ships injection.

### 7.1 Tracking SDK changes (binding, not optional)

The hook lives in `experimental.*`. opencode may rename it, graduate it to a stable namespace, change the signature, or remove it entirely. We commit to four monitoring mechanisms so a breaking change reaches us *before* it reaches users:

1. **Pinned SDK version + CI guard on bumps.** `peerDependencies` and `devDependencies` pin `@opencode-ai/plugin` to a specific minor (`^1.15.10` today). The plugin's CI runs `tsc --noEmit` against the pinned version. Any future SDK bump (via a manual PR or a dependabot proposal) re-runs the typecheck — a signature change fails the build loudly.

2. **CHANGELOG release-note check on the SDK side.** Before merging any SDK bump, the merging reviewer scans the [opencode CHANGELOG](https://github.com/anomalyco/opencode/blob/main/CHANGELOG.md) (or release notes) for any line mentioning `chat.system.transform`, `system.transform`, or `experimental` deprecations. A CI step grepping the release notes when an SDK version is bumped catches this automatically.

3. **Watch graduation: experimental → stable.** If the hook moves from `experimental.chat.system.transform` to `chat.system.transform` (or similar), opencode typically keeps the experimental alias working for a transition period. Our handler should be rewritten to use the new stable name in the same PR that bumps the SDK version. The eyeball test (§7 step 4) verifies the migration works.

4. **Periodic re-verification.** Quarterly (or before each `the-librarian` minor release, whichever is sooner), an operator runs the eyeball test in a real opencode session to confirm injection still reaches the LLM. Catches silent-discard regressions even if the type signature is unchanged.

These four are listed in the plugin repo's `AGENTS.md` so future maintainers inherit the responsibility.

---

## 8. Success criteria

- [ ] `experimental.chat.system.transform` is registered as a hook in the plugin and fires on every chat turn.
- [ ] The handler renders the canonical `<conversation-state>` block byte-identically with the other four plugins (asserted by a fixture test comparing the block string against a captured snapshot).
- [ ] `conv_state_get` is called at most once per `system.transform` invocation (no duplicate fetches).
- [ ] Off-record state suppresses every Librarian call for the turn — the privacy gate's `state.private` is read before the MCP client is touched.
- [ ] A Librarian outage (port closed, network failure, or 500 response) produces no stack trace, no blocked turn, and no visible artefact in the user transcript.
- [ ] Adding a second domain to a fresh Librarian install + seeding a `conv_state` row via the dashboard causes the next opencode turn to carry the canonical block in its system prompt. Clearing the row causes the following turn to carry nothing.
- [ ] **Eyeball-test gate (pre-release):** in a real opencode session, ask the model a question that requires the conv-state context to answer; verify the model answers correctly. Closes the residual risk from issue #17100.

---

## 9. Open questions

- **Issue #17100 confirmation.** The closed-as-not-planned bug claims `experimental.chat.system.transform` mutations are silently discarded under some conditions. The agentmemory plugin's continued operational status suggests the bug is condition-specific rather than the common path, but until we run the eyeball-test step ourselves we don't know which condition we're in. If injection silently fails on first deploy, escalate upstream with a fresh repro.
- **`experimental.*` namespace stability.** The hook lives in the experimental namespace, meaning opencode may rename or remove it in a major version. We accept this risk and commit to tracking it. The dependency footprint is small enough that a one-day re-wire is the worst case.
- **Should `is_global` filtering be visible to opencode plugins?** Out of scope. The §4.11 hard filter on `recall` is server-side and uniform across all integrations. opencode users get domain isolation for free once the injection is in place.
- **Pi extension parity.** The sibling spec [`pi-extension-conv-state-injection-spec.md`](./pi-extension-conv-state-injection-spec.md) faces a similar investigation but is not closed yet. Reading Phase A findings from this spec may give Pi's investigation a head start on what to look for.

---

## 10. Sources

Phase A findings drew on these references. Linked here so future readers can verify or update.

- [`@opencode-ai/plugin/dist/index.d.ts`](https://www.npmjs.com/package/@opencode-ai/plugin) at v1.15.10 — authoritative hook surface. The plugin repo's `node_modules/@opencode-ai/plugin/dist/index.d.ts` lines 264-269 define the `experimental.chat.system.transform` signature.
- [johnlindquist's OpenCode plugin guide gist](https://gist.github.com/johnlindquist/0adf1032b4e84942f3e1050aba3c5e4a) — community-maintained reference; shows the basic injection pattern.
- [rohitg00/agentmemory `/plugin/opencode`](https://github.com/rohitg00/agentmemory/tree/main/plugin/opencode) — production plugin using exactly this hook for memory-style context injection. Two-layer pipeline (project profile + recent observations).
- [rmk40's "OpenCode prompt construction" gist](https://gist.github.com/rmk40/cde7a98c1c90614a27478216cc01551f) — explains the system-prompt assembly pipeline and where plugin hooks fit.
- [obra/superpowers OpenCode README](https://github.com/obra/superpowers/blob/main/docs/README.opencode.md) — another community example of plugin hook usage.
- [`anomalyco/opencode#17100`](https://github.com/anomalyco/opencode/issues/17100) — closed-as-not-planned bug report on silent-discard. Risk we're tracking.
- [`anomalyco/opencode#17637`](https://github.com/anomalyco/opencode/issues/17637) — feature request to include user message text in the hook's input. Confirms the hook does NOT currently see the user message, which is fine for our use case (conv-state is independent of the user's current message).
- [`anomalyco/opencode#6142`](https://github.com/anomalyco/opencode/issues/6142) — older request to add sessionID to the hook input. The type signature confirms sessionID is now present (as an optional field), so this request was satisfied in some prior release.
- [opencode plugin docs](https://opencode.ai/docs/plugins) — public documentation. The `experimental.chat.system.transform` hook is not currently documented here (only `experimental.session.compacting` is) but the type definition is authoritative.

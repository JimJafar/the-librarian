# Spec: Pi Extension — Conv-State Injection

**Author:** Claude, with Jim
**Date:** 2026-05-27
**Status:** Draft v2 — Phase A investigation complete; hook identified as `before_agent_start` (stable namespace); design ready for implementation

---

## 1. Purpose

[`memory-domain-isolation-and-conv-state.md`](./memory-domain-isolation-and-conv-state.md) §4.9 defines a per-turn hook contract: every harness integration injects a `<conversation-state>` block ahead of each user message so the LLM sees the current `domain` / `session_id` / `off_record` on every turn — defeating context-compaction-driven state loss.

Three of the five Librarian plugins already implement this (Claude Code, Hermes, Codex). The Pi extension was deferred because its `pi.on("input")` handler returns `{action: "continue"}` and the extension SDK doesn't visibly expose a "context-injection" pattern from the surface the plugin reaches.

This spec scopes the closing-the-deferral work.

---

## 2. Non-goals

- **Not redefining the §4.9 contract.** The rendered block is byte-identical across all five plugins; this spec adapts the *injection mechanism* to Pi's SDK, not the *payload*.
- **Not changing the `pi.on("input")` handler's existing privacy / lifecycle behaviour.** The conv-state injection rides alongside the existing flow.
- **Not introducing a Librarian-specific build of the Pi extension SDK.** If the SDK genuinely doesn't expose a workable surface, the answer is an upstream PR (or a "blocked on upstream" status), not a fork.
- **Not unifying opencode + Pi.** The two specs run in parallel; they may share investigation findings but each adapts to its own SDK.

---

## 3. Background

### 3.1 What works in the other three plugins

| Plugin | Hook event | Mechanism |
|---|---|---|
| Claude Code | `UserPromptSubmit` | Stdout JSON envelope: `additionalContext` field |
| Codex | `UserPromptSubmit` | Same envelope shape |
| Hermes | `prefetch(query)` provider method | Return-string concatenation |

Each lets the integration add text to the model's context without modifying the user's literal prompt.

### 3.2 What the Pi extension exposes today

From the existing extension at `the-librarian-pi-extension/extensions/librarian/index.ts`:

```ts
pi.on("input", async (event, ctx) => {
  if (event.source === "extension") return { action: "continue" } as const;
  const text = event.text.trim();
  if (text.startsWith("/") || text.length === 0) return { action: "continue" } as const;
  await getOrchestrator(ctx.cwd).handlePrompt(event.text);
  refreshStatus(ctx);
  return { action: "continue" } as const;
});
```

The handler signature returns `{ action: "continue" }` — an enum-like response that allows the input to proceed but does not (visibly, from this code) carry additive context. The other events used (`tool_call`, `agent_end`, `session_compact`, `session_shutdown`, `session_start`) are side-effect hooks without a return-value mutation path either.

The deferral note from the autonomous-build artefact reads:

> Pi extension — `pi.on("input")` returns `{action: "continue"}` and doesn't expose a "context injection" pattern in the SDK surface visible from the extension. Same problem at a different layer.

The right answer almost certainly exists in the `@earendil-works/pi-coding-agent` SDK — possibly a different action enum value (e.g. `{ action: "augment", text: "..." }`), possibly a different event we haven't surveyed (a "before-model" hook), or possibly a system-prompt API distinct from the input stream.

---

## 4. The contract

### 4.1 Phase A — investigation findings

Phase A was completed on 2026-05-27 against `@earendil-works/pi-coding-agent` v0.75.5 (the version pinned in the plugin's `package.json`).

**The hook is `before_agent_start`.** Defined in `@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` (lines 467-478 + result type 735-739):

```typescript
interface BeforeAgentStartEvent {
    type: "before_agent_start";
    /** The raw user prompt text (after expansion). */
    prompt: string;
    /** Images attached to the user prompt, if any. */
    images?: ImageContent[];
    /** The fully assembled system prompt string. */
    systemPrompt: string;
    /** Structured options used to build the system prompt. */
    systemPromptOptions: BuildSystemPromptOptions;
}

interface BeforeAgentStartEventResult {
    message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
    /** Replace the system prompt for this turn.
     *  If multiple extensions return this, they are chained. */
    systemPrompt?: string;
}
```

**Why this is even better than opencode's surface:**

- **Stable namespace, not experimental.** Unlike `experimental.chat.system.transform`, this is a load-bearing public surface that the SDK ships with usage examples. No risk of namespace graduation breaking the integration.
- **Receives the assembled system prompt.** We get `event.systemPrompt` already built, append our block, return the result. No ambiguity about position or concatenation order.
- **Explicit chaining for multiple extensions.** The result-type comment confirms: "If multiple extensions return this, they are chained." Multiple plugins can safely append without stomping each other.
- **Operates on `systemPrompt` not `event.prompt`.** Our additions are system-prompt-shaped, semantically correct — the LLM sees them as instructions, not as user input.

**Cadence:** fires "after user submits prompt but before agent loop" per the SDK comment. Per-turn, exactly the cadence §4.9 needs.

**Type-level spike clean.** A throwaway extension that does `return { systemPrompt: event.systemPrompt + "\n\n" + renderConvStateBlock(state) }` from a `pi.on("before_agent_start", ...)` handler typechecks cleanly against the SDK types.

**SDK ships five canonical examples.** The pattern is officially blessed. Most directly relevant:

- `examples/extensions/claude-rules.ts` — appends a fixed block (project rules) to `event.systemPrompt` via the chained-systemPrompt return. The exact shape we need.
- `examples/extensions/pirate.ts` — same pattern, simpler payload (style instructions).
- `examples/extensions/preset.ts` — same pattern, dynamic payload (active preset's instructions). Template-string interpolation.
- `examples/extensions/ssh.ts` — uses `event.systemPrompt.replace(...)` to swap-rather-than-append. Different shape, same hook.

**Other surfaces considered and rejected:**

- `pi.on("input", ...)` — the existing extension already uses this; its `InputEventResult` return supports `{ action: "transform", text: ... }` which modifies the user's literal text. Off-the-table per spec §4.3.
- `pi.on("context", ...)` — receives the messages array, can mutate. Too low-level; would let us prepend a synthetic message but `before_agent_start.systemPrompt` is the cleaner semantic.
- `ExtensionContext.getSystemPrompt()` — a query method, not a mutate-able hook. Wrong direction.
- `pi.ui.*` surface — display-only, not prompt-affecting.

### 4.2 Phase B — design

**Hook handler:**

```typescript
// extensions/librarian/handlers/system-prompt-augment.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderConvStateBlock } from "../conv-state-render.js";

const CONV_STATE_TIMEOUT_MS = 500;

export function registerSystemPromptAugment(
  pi: ExtensionAPI,
  deps: {
    mcp: { convStateGet: (convId: string, timeoutMs: number) => Promise<...> | null };
    state: { isPrivate: () => Promise<boolean> };
    log: (entry: object) => Promise<void>;
  },
): void {
  pi.on("before_agent_start", async (event, _ctx) => {
    try {
      // Privacy gate: off-record suppresses every Librarian call.
      if (await deps.state.isPrivate()) return;

      // Conv-id from the Pi session name. Stable per Pi session; same
      // value the existing extension uses for source_ref derivation.
      const sessionName = pi.getSessionName();
      if (!sessionName) return;
      const convId = `pi:${sessionName}`;

      // Fail-soft fetch. Any error → silent return, system prompt unchanged.
      const state = await deps.mcp.convStateGet(convId, CONV_STATE_TIMEOUT_MS);
      if (!state) return;

      // Append the canonical block to the assembled system prompt.
      // The chained-extensions contract means we concatenate, never replace.
      return {
        systemPrompt: event.systemPrompt + "\n\n" + renderConvStateBlock(state),
      };
    } catch (err) {
      await deps.log({
        event: "before_agent_start",
        outcome: "conv_state_inject_threw",
        error: String((err as Error)?.message ?? err),
      });
      // Silent return — never block the turn.
      return;
    }
  });
}
```

**Wired into the existing extension entry point** (`extensions/librarian/index.ts`) alongside the existing `pi.on("input", ...)` and `pi.on("session_*", ...)` registrations. No changes to existing handlers.

**Conv-id derivation:** `pi:${pi.getSessionName()}` — guarded by an early-out when `getSessionName()` returns undefined (the existing extension already uses this value for `derivePiSourceRef`, so the conv-id is stable for the same session that owns the source_ref).

**Privacy gating:** reuses the plugin's existing orchestrator state check. Identical guard pattern to the existing `pi.on("input", ...)` handler.

**Fail-soft contracts:**
- Missing `getSessionName()` → silent return.
- Off-record → silent return.
- `convStateGet` timeout (500ms) → silent return.
- `convStateGet` network failure → silent return.
- `convStateGet` parse failure → silent return.
- Any unexpected throw → caught, logged, silent return.

When the handler returns nothing (no block to inject) or returns `undefined`, the SDK leaves the system prompt unchanged. Multiple extensions returning `systemPrompt` are chained — our extension is one chain element, not a replacement.

**Where the renderer lives:** new file `extensions/librarian/conv-state-render.ts`, byte-identical with the other four plugins' implementations (per the AGENTS.md "five peer implementations" rule).

**Where the MCP call goes:** the existing `extensions/librarian/vendor/mcp-client.ts` already speaks to the Librarian endpoint. We add a `convStateGet(convId, timeoutMs)` helper alongside the existing tool helpers.

### 4.3 What we won't do

- Modify `event.prompt` from `before_agent_start` — corrupts the visible transcript and isn't what the hook is for. The `systemPrompt` return is the right field.
- Modify `event.text` in `pi.on("input", ...)` via the `transform` action. Off-the-table per the parent spec's §4.9 contract.
- Inject via the existing memory-tools surface (treating the block as a synthetic recall result). The block is *state*, not a memory — different surface.
- Use `pi.on("context", ...)` to prepend a message. The `before_agent_start.systemPrompt` route is the cleaner semantic.
- Add a static config-file injection. Stale by design.

---

## 5. Tech stack

- **Plugin repo:** `the-librarian-pi-extension` (TypeScript, `tsc` toolchain, `extensions/librarian/` layout).
- **New runtime deps:** none anticipated. The extension already has an MCP client (`extensions/librarian/vendor/mcp-client.js`) and a state store.
- **Family-wide block renderer:** byte-identical to the other four plugins' renderers. Local replication (consistent with the AGENTS.md five-peer rule) rather than a shared dependency.
- **Pi SDK:** `@earendil-works/pi-coding-agent` ^0.75.5 (the pinned version). The hook lives in a stable namespace; no SDK bump required for V1.

---

## 6. Decisions

- **D1.** Hook surface is `before_agent_start`. Identified in Phase A; confirmed by type-level spike + five SDK-shipped canonical examples that ship with the package (`claude-rules.ts`, `pirate.ts`, `preset.ts`, `ssh.ts`, plus uses in `qna.ts` / `prompt-customizer.ts`).
- **D2.** Mutation pattern: return `{ systemPrompt: event.systemPrompt + "\n\n" + renderConvStateBlock(state) }`. Matches the canonical `claude-rules.ts` / `pirate.ts` examples exactly. The SDK's documented chaining means our extension cooperates with any other plugin that also augments the system prompt.
- **D3.** Never modify `event.prompt` (the user's literal text) or use `pi.on("input", ...)`'s `transform` action. Conv-state belongs in the system prompt, not in the user's message.
- **D4.** Conv-id convention: `pi:<session-name>` via `pi.getSessionName()`. Reuses the same value the existing extension already uses for `derivePiSourceRef`. The conv-id remains brief in the rendered block; the full source_ref still goes on the Librarian session row when one is created.
- **D5.** Privacy gate (`state.isPrivate()`), fail-soft (every error path returns silently), sub-500ms `convStateGet` budget — all binding, all from existing house rules.
- **D6.** Local renderer (`extensions/librarian/conv-state-render.ts`) rather than a `@librarian/core` dependency. Five peer implementations, no canonical source — same as the other four plugins.
- **D7.** `before_agent_start` is in the SDK's **stable** namespace (no `experimental.*` prefix). Unlike the opencode integration's `experimental.chat.system.transform`, we don't need the four-mechanism monitoring plan from that spec. The standard "pin the SDK + tsc in CI" hygiene covers it.

---

## 7. Migration / rollout

One PR in the extension repo. Phase A is closed (§4.1 evidence committed; §4.2 design ready).

1. **Create the handler + supporting modules:**
   - `extensions/librarian/handlers/system-prompt-augment.ts` — the new hook implementation.
   - `extensions/librarian/conv-state-render.ts` — the canonical block renderer.
   - Extend `extensions/librarian/vendor/mcp-client.ts` with `convStateGet(convId, timeoutMs)`.
2. **Wire into the extension entry point** (`extensions/librarian/index.ts`) alongside the existing `pi.on(...)` registrations. No changes to existing handlers.
3. **Tests** (`tests/system-prompt-augment.test.ts`): four cases mirroring the codex / hermes pattern — state hit appends the block (verified by inspecting the returned `systemPrompt` against the input plus block); no state → handler returns `undefined`; `convStateGet` throws → silent return, no thrown error; off-record → no MCP call at all.
4. **Eyeball-test post-deploy.** In a real Pi session against a Librarian with a seeded conv_state row, ask the model "what domain are you in?" Verify the model answers correctly. (Less risk-laden than opencode's eyeball test because Pi's hook is stable namespace and the SDK ships canonical examples of this exact pattern — but worth a one-time confirmation that our wiring is right.)
5. **CHANGELOG entry under `## [Unreleased]`.**

No user-facing migration. Existing users keep running the current extension; the next release ships injection.

---

## 8. Success criteria

- [ ] `pi.on("before_agent_start", ...)` is registered and fires on every chat turn.
- [ ] The handler returns `{ systemPrompt: event.systemPrompt + "\n\n" + block }` when conv_state exists; returns `undefined` (or doesn't return) otherwise.
- [ ] The rendered `<conversation-state>` block is byte-identical with the other four plugins (asserted by a fixture test against a captured snapshot).
- [ ] `conv_state_get` is called at most once per `before_agent_start` invocation.
- [ ] Off-record state suppresses every Librarian call — `state.isPrivate()` is checked before the MCP client is touched.
- [ ] A Librarian outage produces no stack trace, no blocked turn, no visible artefact in the user transcript.
- [ ] Adding a second domain to a fresh Librarian install + seeding a `conv_state` row via the dashboard causes the next Pi turn to carry the canonical block in its system prompt. Clearing the row causes the following turn to carry nothing.
- [ ] **Eyeball-test gate (pre-release):** in a real Pi session, ask the model a question that requires the conv-state context to answer; verify the model answers correctly.

---

## 9. Open questions

- **SDK version bump cadence.** The pinned version is `^0.75.5`. The pi-coding-agent's pre-1.0 versioning means semver-minor bumps can still be breaking. Standard hygiene applies: pin in package.json, run `tsc --noEmit` in CI, review the SDK CHANGELOG before merging any bump. Less risk-laden than opencode's experimental-namespace situation; doesn't need a dedicated monitoring plan.
- **Conv-id format: name vs full source_ref.** Decision in D4 is `pi:<session-name>`. The alternative `pi:<full-source-ref>` (e.g. `pi:cwd:/Users/jim/work/foo` or `pi:device:<id>:cwd:/path`) would carry more cross-harness coordination potential but the conv-state lookup only needs to be stable per Pi session. Revisit if cross-harness handover *into* Pi proves awkward with the short name.
- **Compaction interaction.** Pi's `session_compact` event fires after compaction; our handler fires on `before_agent_start` which is per-turn. After compaction, the next turn's `before_agent_start` fires, re-injects from conv_state, and the model sees current state again — same defeat-compaction mechanic as the other four plugins. No special handling needed.

---

## 10. Sources

Phase A findings drew on these references — all from the locally-installed SDK at v0.75.5.

- **`@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`** — authoritative hook surface. Lines 467-478 define `BeforeAgentStartEvent`; lines 735-739 define `BeforeAgentStartEventResult` with the `systemPrompt?` field and the chained-extensions comment.
- **`examples/extensions/claude-rules.ts`** — SDK-shipped canonical example. Appends a fixed project-rules block via the same `return { systemPrompt: event.systemPrompt + ... }` pattern we use. Closest shape to our use case.
- **`examples/extensions/pirate.ts`** — minimal SDK-shipped example demonstrating "`systemPromptAppend`" (per the examples README).
- **`examples/extensions/preset.ts`** — dynamic-content example; template-string interpolation with `${event.systemPrompt}\n\n${activePreset.instructions}`. Confirms dynamic per-turn payloads work fine through this hook.
- **`examples/extensions/ssh.ts`** — uses `event.systemPrompt.replace(...)` to swap-rather-than-append. Same hook, different mutation pattern. Confirms the systemPrompt field is fully mutable.
- **`docs/extensions.md`** — local SDK docs (under `node_modules/.../docs/`). Background reference for the extension lifecycle.

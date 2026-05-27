# Spec: Pi Extension — Conv-State Injection

**Author:** Claude, with Jim
**Date:** 2026-05-27
**Status:** Draft v1 — investigation phase; design pinned to whatever the pi-coding-agent SDK surfaces

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

### 4.1 Phase A — investigation (mandatory pre-work)

Goal: identify, in `@earendil-works/pi-coding-agent`'s public TypeScript types and any extension docs the package ships, the mechanism that lets an extension add text to the model's context per turn **without** modifying the user's literal input.

Tasks:

1. **Read the SDK types.** Walk `node_modules/@earendil-works/pi-coding-agent/dist/`. List every event `pi.on(...)` accepts, plus the full type of each handler's return value. Look specifically for a discriminated union with a `"augment"` / `"inject"` / `"add-context"` variant.
2. **Read the extension API surface.** Beyond `pi.on(...)`, walk every method on `ExtensionAPI`. The existing extension uses `pi.registerCommand`, `pi.getSessionName()`, `pi.ui.*`, `pi.status.*`. Look for a `pi.systemPrompt.*` / `pi.context.*` / `pi.prompt.*` surface that contributes to the model's prompt build.
3. **Check the SDK's own example extensions** in `node_modules/@earendil-works/pi-coding-agent/examples/` if present. Real example code is the fastest disambiguator.
4. **Spike.** A 30-line throwaway extension that emits a known string via the candidate mechanism. Verify the LLM reads it and it does not appear in the visible chat transcript.
5. **Update this spec's §4.2 with the chosen mechanism and the spike's evidence.** No production code until §4.2 is filled in.

If no such surface exists in the SDK today, the outcome is an upstream feature request to Pi and a documented "blocked on upstream" status. The fallback "modify `event.text`" is explicitly off the table — that would surface in the visible transcript.

### 4.2 Phase B — design (filled in after Phase A)

*Placeholder. Populated by Phase A.*

Expected shape:

- **Hook event / API call:** `<TBD — likely a system-prompt or before-completion surface>`.
- **Mechanism:** call `conv_state_get` against the configured endpoint via the existing `mcp-client.ts` vendor module, parse, render the canonical block, return via the chosen mechanism.
- **Conv-id derivation:** `pi:<session-name>` where `<session-name>` is `pi.getSessionName()`. This matches the family prefix convention from spec §4.8.
- **Privacy gating:** the existing `state.private` flag suppresses every Librarian call; the conv-state lookup adopts the same gate.
- **Fail-soft:** unchanged — any error returns the no-op continuation, the LLM never sees a stack trace.

### 4.3 Conv-id convention

`pi:<session-name>` where `<session-name>` is the value `pi.getSessionName()` returns at the moment of the input hook. The existing extension already uses `pi.getSessionName()` to derive `source_ref` — we reuse the same value so the conv-id is stable per Pi session. Documented here so it's set before Phase A picks the mechanism.

### 4.4 Privacy + fail-soft contracts (binding from Phase A onward)

Same set as the opencode spec — these come from `the-librarian-pi-extension/AGENTS.md` and the parent spec, and are non-negotiable in any Phase B design:

- **No MCP call while off-record.** The orchestrator's existing state check gates every Librarian call.
- **Fail-soft on every error path.** Network, parse, schema, model-unavailable, missing-token, missing-endpoint — all of them return the existing `{ action: "continue" }` response.
- **Sub-500ms budget.** The input hook must not stall the turn for more than half a second. If `conv_state_get` exceeds the budget, the turn proceeds without injection.

### 4.5 What we won't do

- Modify `event.text` to inject context. Would corrupt the visible transcript.
- Inject via the existing memory-tools surface (e.g. by treating the block as a synthetic recall result). The block is *state*, not a memory — different surface.
- Add a static config-file injection. Stale by design.

---

## 5. Tech stack

- **Plugin repo:** `the-librarian-pi-extension` (TypeScript, `tsc` toolchain, `extensions/librarian/` layout).
- **New runtime deps:** none anticipated. The extension already has an MCP client (`extensions/librarian/vendor/mcp-client.js`) and a state store.
- **Family-wide block renderer:** byte-identical to the other four plugins' renderers. Local replication (consistent with the AGENTS.md five-peer rule) rather than a shared dependency.
- **Pi SDK:** `@earendil-works/pi-coding-agent` (whatever version this extension is pinned to). Phase A may surface that we need a newer SDK version, or an upstream change.

---

## 6. Decisions

- **D1.** Investigation-first. No code until Phase A produces a workable mechanism + spike evidence.
- **D2.** Never modify `event.text`. The block belongs in a side-channel, not the user's literal input.
- **D3.** Conv-id convention: `pi:<session-name>`. Reuses `pi.getSessionName()` for stability across the Pi session.
- **D4.** Privacy gate, fail-soft, sub-500ms budget — all binding.

---

## 7. Migration / rollout

One PR in the extension repo, contingent on Phase A:

1. Land Phase A as documentation: §4.2 filled in, spike report committed alongside.
2. PR the implementation: a new branch off the existing input / before-model hook in `extensions/librarian/index.ts`.
3. Tests: the existing `tests/` layout has handler-level coverage; mirror it (4 cases — hit, miss, throw, off-record).
4. CHANGELOG entry under `## [Unreleased]`.

No user-facing migration. The next extension release ships injection.

---

## 8. Success criteria

- [ ] Phase A produces a named SDK mechanism + a 30-line spike showing the LLM reads injected text that does not appear in the visible transcript.
- [ ] The implementation renders the canonical `<conversation-state>` block byte-identically with the other four plugins.
- [ ] `conv_state_get` is called at most once per user turn.
- [ ] Off-record state suppresses every Librarian call for the turn.
- [ ] A Librarian outage produces no stack trace, no blocked turn, no visible artefact in the transcript.
- [ ] Adding a second domain to a fresh install and seeding a `conv_state` row makes the next Pi turn carry the canonical block; clearing the row makes the following turn carry nothing.

---

## 9. Open questions

- **Does the Pi SDK have a system-prompt augment hook?** This is the unknown that gates the whole spec. The investigation in §4.1 answers it.
- **If not — is there an upstream PR worth opening?** The Pi SDK is `@earendil-works/pi-coding-agent`; depending on what it exposes, a small upstream PR adding a `before-model` or `system-prompt-fragment` hook may be the cleanest path. Lower-priority alternative to a workaround.
- **Sharing Phase A findings with the opencode spec.** [`opencode-conv-state-injection-spec.md`](./opencode-conv-state-injection-spec.md) faces the same investigation against a different SDK. The two should run in the same week so any cross-SDK patterns we learn (e.g. "the augment-context pattern is increasingly common") feed back into both designs.
- **Pi's session model and `source_ref`.** The existing extension uses `derivePiSourceRef({cwd, piSessionId, deviceId})`. Whether the conv-id should be `pi:<session-name>` or the full source_ref is a small open question — the conv-id only needs to be stable per Pi session, but using the full source_ref keeps it cross-harness-consistent. Recommendation: `pi:<session-name>` for brevity in the rendered block; the source_ref still goes on the session row when one is created.

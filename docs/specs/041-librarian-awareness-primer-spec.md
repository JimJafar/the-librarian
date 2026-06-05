# Spec 041 — Librarian awareness primer

**Status:** Draft for review (Specify phase)
**Version target:** MINOR (new server-sourced setting + a small, lockstep response-shape
change to `conv_state_get`; no behaviour change when the primer is empty)
**Depends on:** the per-turn conv-state injection contract (specs 022 §4.9, 024–026, shipped);
the `SettingsStore` + dashboard-config pattern (curator settings, shipped)
**Relates to:** `docs/research/harness-driven-capture-brainstorm.md` (the working doc — this
spec is feature **1B**, decisions **D1 / D9** and §3.2; feature 1A "auto-capture" is shelved)
**Cross-repo:** lockstep change across **6 repos** — `the-librarian` (server + dashboard) +
the five plugins (`-claude-plugin`, `-codex-plugin`, `-hermes-plugin`, `-pi-extension`,
`-opencode-plugin`). The `conv_state_get` response shape is a *sacred cross-repo contract*
(AGENTS.md §2) — change all or none, in one coordinated push.

---

## Objective

**What.** On every turn, in every one of the five harnesses, inject a short,
**server-sourced** note telling the model that the Librarian exists and which verbs to reach
for — e.g. *"You have The Librarian: durable cross-session memory. Use `recall` to check what
you already know before asking, and `remember` / `learn` to save durable facts."* The text
rides the **existing** per-turn `<conversation-state>` injection channel; it is **passive**
(awareness only — not active recall-injection) and **brief** (1–2 sentences, a context-budget
floor, not a replacement for the skill).

**Why.** We can't rely on the agent auto-loading the Librarian skill/plugin (the brainstorm's
§3.2 reliability-floor argument). Without a deterministic primer, an agent may never realise the
Librarian is available and simply never call `recall` / `remember`. The conv-state block already
fires every turn in all five plugins and already survives compaction by re-injecting each turn —
so a primer that rides it gets **compaction-survival for free** with **no new hook** (brainstorm
D9, which resolved blind-review Critical **C2**: idea B was "stamped, never designed").

**Who.** Every Librarian user on every harness. Server-sourced means the admin can edit the
primer text from the dashboard **without re-releasing any plugin**.

**Success, in one line.** A fresh conversation on **any** of the five harnesses — including
**Codex** (no stable per-conversation id) and including the **first turn before any conv-state
row exists** — carries the server's primer in the model's context, and editing the primer text in
the dashboard changes what the next turn sees, with no plugin redeploy.

---

## Background — what's there, and the gap

### What already works (frozen evidence, 2026-06-05)

- **One per-turn server round-trip, already universal.** Every plugin calls `conv_state_get`
  once per turn and renders the block client-side:
  - claude — `UserPromptSubmit` hook, emits via `hookSpecificOutput.additionalContext`
    (`the-librarian-claude-plugin/src/bin/conv-state-inject.ts:42-66`; MCP call `:120-148`).
  - codex — `UserPromptSubmit`, same envelope
    (`the-librarian-codex-plugin/plugins/the-librarian/bin/librarian-codex-hook.js:20-57`; call `:33`).
  - hermes — `system_prompt_block()` / `prefetch()`
    (`the-librarian-hermes-plugin/provider.py:212-217,228-249`; call `:239`; prefix `:405-411`).
  - pi — `before_agent_start`, appends to `event.systemPrompt`
    (`the-librarian-pi-extension/extensions/librarian/handlers/system-prompt-augment.ts:38-61`; call `:45`).
  - opencode — `experimental.chat.system.transform`, pushes onto `output.system`
    (`the-librarian-opencode-plugin/src/handlers/system-transform.ts:36-57`; call `:45`).
  - **Consequence:** adding primer text to the `conv_state_get` *response* reaches every turn in
    every harness **with zero new network cost and no new hook.**
- **The renderer is five byte-identical peer copies, not a shared dependency.** Canonical
  source `packages/core/src/conv-state-render.ts:26-35` renders a two-field block
  (`conv_id` + `off_record`; returns `""` when state is null); each plugin replicates it locally
  (AGENTS.md §2 "five peer implementations" rule; spec 025 D5). Any block-shape change is therefore
  a deliberate lockstep edit in all six repos.
- **Server-sourced text has a proven pattern.** `session_manifest` already reads a settings value
  server-side (`working_style` via `getSetting`, `packages/mcp-server/src/mcp/tools/session-manifest.ts:14-20`,
  fail-soft → `""`); the curator config is the proven **dashboard-edited setting** pattern (admin
  tRPC `trpc/curator.ts:25-37`; worker reads the setting). A new primer setting is a copy of an
  existing, working shape.

### The gap

- `conv_state_get` returns **only** the conv-state row (or the text `"No conversation state for
  conv_id…"`) — `packages/mcp-server/src/mcp/tools/conv-state-get.ts:22-28`. It carries no primer.
- `renderConvStateBlock(null)` returns `""` — so on a **brand-new conversation with no row**, the
  block is empty and nothing is injected. A primer must appear **even when there is no row** (its
  whole job is the day-one floor), so it cannot be a field *on the row*.
- `session_manifest` (the richer F6 preamble: working-style + skills manifest) has **zero callers**
  in any plugin. That richer preamble is a **deferred** upgrade (brainstorm D9) — **out of scope
  here**. 1B ships the brief primer only.

---

## The change

### 1. Server — a new server-sourced primer setting (dashboard-editable)

- Add a `SettingsStore` key (proposed `awareness.primer`, string) with a **shipped default** so
  the primer works out-of-the-box before any admin edit. **Empty string disables it** (no block).
- Surface it on the dashboard with an admin tRPC read/write, mirroring the curator-config pattern
  (`trpc/curator.ts:25-37`): a labelled textarea on an existing admin/settings page, with the
  shipped default pre-filled and a short "this text is injected every turn on every harness" hint.
- Reads are **fail-soft**: if the setting store is locked/unreadable, treat the primer as `""`
  (same posture as `readWorkingStyle`), never throw.

### 2. Server — `conv_state_get` returns the primer alongside the row

`conv_state_get` reads the primer setting and returns it **on every call, whether or not a
conv-state row exists**. Recommended response shape (final wire detail is the implementer's, see
Open Questions):

```jsonc
{
  "state": { "conv_id": "...", "off_record": false, /* … */ } | null,
  "primer": "You have The Librarian: durable cross-session memory. Use `recall` before asking; `remember` / `learn` to save durable facts."
}
```

- This **replaces** the bare-row JSON and the `"No conversation state…"` text response — a
  deliberate, lockstep response-shape change (sacred contract).
- The primer is **global, not conversation-keyed** — it does **not** depend on `conv_id` being
  stable or on a row existing. This is what makes 1B work on **Codex** (only a per-cwd fallback id,
  the genuine blocker for the *capture* feature) and on the **first turn** of any conversation.
- **`off_record` does not suppress the primer.** The primer is generic awareness text with no
  conversation content; the off-record gate still governs all actual recording. (Phrase the
  default primer so it doesn't *urge* recording — "use `recall`; `remember` when appropriate" — so
  it reads sensibly even mid-off-record. See Open Questions on tone.)

### 3. Plugins — render the primer block (×5, byte-identical)

Each plugin's local renderer gains a sibling `renderAwarenessPrimer(primer)` that returns a small
block (proposed `<librarian>…</librarian>`) when `primer` is non-empty and `""` otherwise; each
injection handler reads `response.primer` and emits `renderAwarenessPrimer(primer)` **alongside**
the existing `renderConvStateBlock(state)` (concatenated into the same `additionalContext` /
`output.system` push / `systemPrompt` append — no second injection point, no second fetch).

- The primer block is **separate** from `<conversation-state>` (it is static awareness, not
  per-turn state) but rides the same emit.
- Keep all five implementations byte-identical (the peer-implementation rule). Update the canonical
  `packages/core/src/conv-state-render.ts` too, as the reference the five copies track.
- Each plugin keeps its existing fail-soft contract unchanged: any error → no block, turn proceeds.

---

## Per-harness feasibility (all five; Codex included)

| Harness | Per-turn injection | Primer feasible? | Note |
|---|---|---|---|
| claude | `UserPromptSubmit` → `additionalContext` | **yes** | already round-trips `conv_state_get` every turn |
| codex | `UserPromptSubmit` → `additionalContext` | **yes** | primer is global → the missing stable `conv_id` (capture's blocker) is irrelevant here |
| pi | `before_agent_start` → `systemPrompt` | **yes** | appends per turn |
| opencode | `experimental.chat.system.transform` → `output.system` | **yes** | pushes per turn; experimental-hook risk already tracked (spec 025 §7.1) |
| hermes | `system_prompt_block()` / `prefetch()` | **yes, verify cadence** | confirm `system_prompt_block()` re-fires per turn (not once at session start) so the primer survives compaction on Hermes — see Open Questions |

The primer's independence from `conv_id` is the key property: **1B is feasible on all five
harnesses**, unlike capture (1A), which Codex blocks.

---

## Commands / Project structure / Testing

- **Server touches:** a new settings key + its default (`packages/core/src/store/settings-*`);
  `packages/mcp-server/src/mcp/tools/conv-state-get.ts` (read the setting, new response shape);
  `packages/core/src/conv-state-render.ts` (reference `renderAwarenessPrimer`); a dashboard admin
  field + tRPC read/write (`apps/dashboard`, mirroring curator config).
- **Plugin touches (×5):** the local renderer (add `renderAwarenessPrimer`) + the injection handler
  (read `response.primer`, emit the block) in each plugin repo, byte-identical.
- **Testing:**
  - Server unit: `conv_state_get` returns `primer` **with a row, with no row, and with the setting
    empty** (empty → `primer: ""`); fail-soft when the setting store is unreadable → `primer: ""`.
  - Per-plugin unit (mirror the existing conv-state tests): primer present → primer block emitted
    even when `state` is null; primer empty → no primer block; `conv_state_get` failure → no block,
    turn proceeds (fail-soft).
  - One **eyeball test per harness** (reuse the spec-025 pattern): seed/keep the default primer, ask
    the model "do you have durable memory and how do you save a fact?" — it can answer from the
    primer alone. Confirms injection reaches the model (and, for opencode, that the experimental
    hook isn't silently discarded — issue #17100).
- **CHANGELOG:** an `## [Unreleased]` entry in **each** of the six repos in the lockstep push.

## Boundaries

- **Always:** brief primer (1–2 sentences); server-sourced (no hard-coded primer text in plugins);
  fail-soft (never block a turn); byte-identical peer renderers; branch + PR per repo; CHANGELOG in
  every repo touched; lockstep across all six (the `conv_state_get` response is a sacred contract).
- **Ask first / out of scope:** the richer `session_manifest` preamble (working-style + skills) —
  deferred (D9); **active recall-injection** ("pull relevant memories and inject them") — deferred
  (D9, this is *passive awareness only*); any capture/auto-learn behaviour (feature 1A — shelved).
- **Never:** make the primer depend on a stable `conv_id` (it must work on Codex + day-one);
  suppress the conv-state row's existing fields; introduce a second per-turn fetch or a new hook.

## Success criteria

- [ ] A new dashboard-editable primer setting exists with a shipped default; clearing it to empty
  disables the primer (no block emitted anywhere).
- [ ] `conv_state_get` returns the primer **on every call**, including when no conv-state row
  exists for the `conv_id`; reads are fail-soft (`""` on unreadable store).
- [ ] All five plugins emit the primer block every turn (byte-identical renderer), alongside the
  conv-state block, with no second fetch and no new hook.
- [ ] **Codex** shows the primer despite having no stable per-conversation id.
- [ ] A **brand-new conversation** (no row yet) shows the primer on its first turn.
- [ ] Editing the primer text in the dashboard changes what the next turn sees — **no plugin
  redeploy**.
- [ ] Eyeball test passes on each harness (model can name the Librarian + a save verb from the
  primer alone); opencode injection confirmed reaching the model.
- [ ] Every error path (store down, parse failure, off-record) leaves the turn unblocked and
  leaks no stack trace into the model's context.
- [ ] Hermes cadence confirmed: the primer re-injects per turn (survives compaction), not once.

## Open questions

1. **Response-shape vs forward-compat.** The clean `{ state, primer }` shape is a breaking change
   to `conv_state_get` (mitigated by lockstep + fail-soft: version skew during rollout just drops a
   block, never crashes). The additive alternative — keep the row at top level and add a `primer`
   field — lets an un-updated plugin keep working through the rollout window. Pick at implementation
   time; recommend `{ state, primer }` for clarity unless a staggered rollout is expected.
2. **Block tag + placement.** `<librarian>` sibling block vs folding the primer into
   `<conversation-state>`. Recommend a separate tag (it is static awareness, not per-turn state).
3. **Tone vs off-record.** Default primer wording that reads correctly even when the user is
   off-record (favour "recall before asking; `remember` when appropriate" over "always remember").
4. **Every-turn vs throttle.** D9 chose every-turn (compaction-survival for free; there is no
   post-compaction signal to throttle against). If the repetition proves wasteful, a first-turn +
   periodic cadence is a later optimisation — but it needs a compaction signal the plugins don't
   currently have. Leave every-turn for v1.
5. **Hermes `system_prompt_block()` cadence** — verify it re-fires per turn before relying on it
   for compaction survival; if it only fires at session start, ride `prefetch()` or the per-turn
   path instead.

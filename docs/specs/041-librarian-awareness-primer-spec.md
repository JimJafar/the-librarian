# Spec 041 — Librarian awareness primer

**Status:** Draft for review (Specify phase) — **decision-complete / build-ready** (no open
questions block dev; the remaining items are deterministic verify-then-fallback gates).
**Version target:** MINOR (new server-sourced setting + a **backward-compatible additive** field on
the `conv_state_get` response; no behaviour change when the primer is empty)
**Depends on:** the per-turn conv-state injection contract (specs 022 §4.9, 024–026, shipped);
the `SettingsStore` + dashboard-config pattern (curator settings, shipped)
**Relates to:** `docs/research/harness-driven-capture-brainstorm.md` (the working doc — this
spec is feature **1B**, decisions **D1 / D9** and §3.2; feature 1A "auto-capture" is shelved)
**Cross-repo:** touches **6 repos** — `the-librarian` (server + dashboard) + the five plugins
(`-claude-plugin`, `-codex-plugin`, `-hermes-plugin`, `-pi-extension`, `-opencode-plugin`) — but
the change is **additive and backward-compatible** (Decision 1): the server adds a `primer` field;
an un-updated plugin ignores it and keeps working (no regression). So the six repos do **not** need
a single atomic push — the server can ship first, each plugin renders the primer once updated. This
respects the spirit of the sacred `conv_state_get` contract (AGENTS.md §2 — don't break consumers)
without an all-or-none merge.

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
  (AGENTS.md §2 "five peer implementations" rule; spec 025 D5). Adding the primer block is therefore
  a coordinated edit across the five plugin renderers + the canonical copy — but **additive**: an
  un-updated plugin simply omits the new block (no regression), so the repos update incrementally.
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

### 2. Server — `conv_state_get` returns the primer as an additive top-level field

`conv_state_get` reads the primer setting and returns it **on every call, whether or not a
conv-state row exists**, as an **additive `primer` field that sits alongside the existing row
fields** (Decision 1 — backward-compatible, so an un-updated plugin ignores it):

```jsonc
// row exists:
{ "conv_id": "...", "off_record": false, /* … existing row fields … */, "primer": "You have The Librarian: durable, cross-session memory. Use `recall` to check what's already known before asking; use `remember` / `/learn` to save durable facts, preferences, and decisions worth keeping." }

// no row for this conv_id:
{ "primer": "…same text…" }
```

- **Why additive, not a `{ state, primer }` wrapper:** the row fields stay top-level, so all five
  plugins' existing `conv_id`-based parsing keeps working untouched, and the server can deploy
  **before** the plugins update without dropping the conv-state block anywhere (a clean wrapper
  would break every un-updated plugin during the rollout window). The no-row case returns `{ primer }`
  (replacing today's `"No conversation state…"` text); old plugins find no `conv_id` → no block,
  exactly as today (fail-soft, no regression).
- The primer is **global, not conversation-keyed** — it does **not** depend on `conv_id` being
  stable or on a row existing. This is what makes 1B work on **Codex** (only a per-cwd fallback id,
  the genuine blocker for the *capture* feature) and on the **first turn** of any conversation.
- Because `primer` is its own top-level field, it is **naturally decoupled from the row gate**: a
  plugin reads `primer` independently of whether it found a conv-state row (this is what fixes the
  Hermes drop-on-no-row problem — see Hermes specifics).
- **`off_record` does not suppress the primer.** The primer is generic awareness text with no
  conversation content; the off-record gate still governs all actual recording. The default text
  (Decision 3) is phrased so it reads sensibly even mid-off-record ("save … worth keeping", not
  "always remember").

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
| hermes | `prefetch()` per-turn — **not** `system_prompt_block()` (session-start only) | **yes, w/ 2 notes** | ride `prefetch`; decouple the primer from the row-existence gate (see below); one residual live-test |

The primer's independence from `conv_id` is the key property: **1B is feasible on all five
harnesses**, unlike capture (1A), which Codex blocks.

### Hermes specifics (verified 2026-06-05, `the-librarian-hermes-plugin/provider.py`)

Reading the Hermes provider resolved the cadence question and surfaced two concrete
implementation requirements:

- **Ride `prefetch()`, not `system_prompt_block()`.** `system_prompt_block()` is *"a frozen recall
  snapshot injected **once at session start**"* (`provider.py:213`) — a primer riding it would
  appear once and die at the next compaction. The per-turn / compaction-survival guarantee already
  rides `prefetch()`: *"the LLM sees the current `conv_id` / `off_record` **on every turn** —
  defeating context-compaction-driven state loss"* (`provider.py:222-223`). The primer must ride
  the same `prefetch()` path.
- **Read the primer independently of the row gate.** Hermes drops the *entire* block when no
  conv-state row exists: `_fetch_conv_state` returns `None` on the `"No conversation state…"`
  response and on any payload lacking `conv_id` (`provider.py:243,249`), and
  `_prefix_with_conv_state(None, …)` returns just the recall text (`provider.py:405-408`). The
  primer must show **even with no row** (success criterion). The **additive response shape
  (Decision 1) makes this clean**: `conv_id` stays top-level so `_fetch_conv_state` is unchanged
  (the row gate keeps working), and a **new one-line read** of `parsed["primer"]` emits the primer
  regardless of whether a row was found. (The `{ state, primer }` wrapper would instead have broken
  `_fetch_conv_state`'s `"conv_id" in parsed` guard — another reason additive wins.)
- **One residual live-test (deterministic, with fallback — does NOT block the build).** Whether the
  Hermes runtime calls `prefetch()` automatically before **every** model API call (vs only on
  agent-driven recall) is a property of the `MemoryProvider` ABC, which *lives in the Hermes
  codebase, not this repo* (`provider.py:16-21`). **Build instruction:** implement the primer on the
  **same path the conv-state block already uses** (`prefetch`/`_prefix_with_conv_state`) — so the
  primer inherits *exactly* the cadence the existing Hermes conv-state injection already has. The
  spec-025-style eyeball test then **verifies** per-turn delivery; **if** it turns out `prefetch`
  isn't per-turn, that's a *pre-existing* limitation of the Hermes conv-state block (not introduced
  here) and the primer is no worse off — also emit it from `system_prompt_block()` (session-start)
  as a floor. Either way the build proceeds; the test informs, it doesn't gate.

---

## Commands / Project structure / Testing

- **Server touches:** a new settings key + its default (`packages/core/src/store/settings-*`);
  `packages/mcp-server/src/mcp/tools/conv-state-get.ts` (read the setting, add the `primer` field);
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
- **CHANGELOG:** an `## [Unreleased]` entry in **each** of the six repos as they update (server
  first, then the five plugins — incremental, not an atomic push, per Decision 1).

## Boundaries

- **Always:** brief primer (1–2 sentences); server-sourced (no hard-coded primer text in plugins);
  fail-soft (never block a turn); byte-identical peer renderers; branch + PR per repo; CHANGELOG in
  every repo touched; keep the `conv_state_get` change **additive / backward-compatible** so the
  contract isn't broken for un-updated plugins (Decision 1 — respects the sacred-contract spirit).
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
- [ ] Hermes: the primer rides `prefetch()` (per-turn), shows even with no conv-state row, and a
  live-test confirms `prefetch()` fires every turn.

## Decisions (settled — build-ready)

**No open question blocks an autonomous build.** The five former open questions are decided below;
the only items that "carry into dev" are deterministic verification gates (eyeball tests) with
defined fallbacks, not design choices.

1. **Response shape = additive `primer` field, backward-compatible** (not a `{ state, primer }`
   wrapper). Row fields stay top-level; `primer` is added; no-row returns `{ primer }`. An un-updated
   plugin ignores `primer` and keeps working, so the server can deploy first and plugins follow
   incrementally (no atomic six-repo merge). See §2. *(Reverses the earlier `{ state, primer }` lean
   — additive is strictly safer for rollout and naturally decouples the primer from Hermes's row
   gate.)*
2. **Block tag = a separate `<librarian>` block**, not folded into `<conversation-state>` (the
   primer is static awareness, not per-turn state). Byte-identical `renderAwarenessPrimer(primer)`
   in all five plugins + the canonical core renderer.
3. **Default primer text** (shipped default; admin-editable; phrased to read sensibly even
   off-record): *"You have The Librarian: durable, cross-session memory. Use `recall` to check
   what's already known before asking; use `remember` / `/learn` to save durable facts, preferences,
   and decisions worth keeping."* Empty string disables the primer.
4. **Cadence = every turn** (D9): compaction-survival for free; there is no post-compaction signal
   to throttle against. A first-turn-plus-periodic cadence is a deferred optimisation that would need
   a compaction signal the plugins don't have. Ship every-turn.
5. **Hermes path = `prefetch()`** (the per-turn channel), not `system_prompt_block()` (session-start
   only); read the primer from the top-level `primer` field, independent of the row gate (Decision 1
   makes this a one-liner). See "Hermes specifics". **Carry-into-dev (non-blocking):** an eyeball
   test verifies `prefetch()` is per-turn; the fallback (also emit from `system_prompt_block()`) is
   defined, so the build never stalls on it.

### Verification gates (run during dev — deterministic, never block design)

These are test steps the build executes, each with a defined outcome — they are **not** unresolved
decisions:
- **Per-harness eyeball test** (spec-025 pattern): model can name the Librarian + a save verb from
  the primer alone. Fallback if a harness fails: that harness's injection path is wrong → fix the
  adapter (the design holds; the other four are unaffected).
- **opencode** injection-reaches-model check (the tracked experimental-hook `#17100` risk, spec 025
  §7.1). Fallback: escalate upstream; opencode degrades to no-primer, others unaffected.
- **Hermes** `prefetch()` per-turn check (Decision 5) with the `system_prompt_block()` floor as
  fallback.

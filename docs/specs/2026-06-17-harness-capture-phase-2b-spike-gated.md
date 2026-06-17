# Spec: harness auto-capture Phase 2B — spike-gated harnesses (Pi, Hermes)

**Status:** Proposed. Written with the `sdlc-spec` method. Phase 2B of
[`2026-06-16-harness-auto-capture.md`](./2026-06-16-harness-auto-capture.md); Claude
(Phase 1) shipped rc.25–29. **This spec covers only the two Librarian-specific harnesses
mem0 does not cover** — Pi and Hermes — so each carries a genuine per-turn-hook
**feasibility spike** with no external reference to lean on. The mem0-proven harnesses
(Codex, OpenCode, Claude Cowork) are split into
[`2026-06-17-harness-capture-phase-2a-proven-ports.md`](./2026-06-17-harness-capture-phase-2a-proven-ports.md)
so their confident, buildable work isn't gated on the spikes here. Grounded against
`main` (rc.29).

## 1. Objective

Extend automatic capture to **Pi** and **Hermes**, so an operator running either feeds
durable lessons into the Librarian without the agent being asked. Each gets a **thin
acquisition adapter** that ships a per-turn conversation **delta** to the **existing**
`POST /transcript` endpoint (rc.24), mirroring the Claude adapter's guarantees. The
server pipeline (buffer → settle-sweep → extractor → curator) is unchanged; only the
per-harness client differs. **Unlike Phase 2A, there is no mem0 reference for these two
— each adapter is gated on a spike that confirms the harness actually exposes a
per-turn hook with a stable session id.** A failed spike means that harness is recorded
BLOCKED with its reason, not forced.

## 2. Grounded facts

**The contract every adapter targets** (`packages/mcp-server/src/http/transcript-intake.ts`):
`POST <origin>/transcript`, `Bearer ${LIBRARIAN_AGENT_TOKEN}`, body
`{ conv_id, harness, seq, turns:[{role,text,ts?}], ended? }`; server redacts, drops
`[private=on]` turns, gates on `curator.intake.enabled`, hard-caps the buffer. **Fixed.**

**The reference adapter** (`integrations/claude/scripts/lib/{capture,cursor,post,transcript}.mjs`):
per-turn delta, per-turn `[private=on]` skip (forward-only), advance-on-ack idempotency,
fail-soft, token-in-header + `redirect:error`; triggered by `UserPromptSubmit` (Claude
`Stop`-bug #29767) with `Stop`/`SessionEnd` supplementary. This is the *shape* the Pi
and Hermes adapters mirror — but in their own runtimes (Pi is TS, Hermes is Python).

**No mem0 reference.** mem0's shipping plugin covers Claude, Codex, OpenCode, Cursor and
Antigravity — **not** Pi or Hermes (both Librarian-specific). So unlike Phase 2A there's
no proven approach to port; we must locate each harness's per-turn hook ourselves and
confirm it hands over the completed turn + a stable session id.

**Current integration state (the starting point each spike probes):**

- **Pi** (`integrations/pi/extensions/librarian`): wires only `before_agent_start`
  today — no per-turn-end handler yet. The §11.2 capability audit placed Pi on the
  "proven floor" (turn likely available in-payload via `AgentMessage`, stable
  `getSessionId()`), but that's an expectation to confirm, not shipped code.
- **Hermes** (`integrations/hermes/librarian`): historically exposed `sync_turn(user,
  assistant)`, since "retired" to a no-op. The spike must confirm whether a provider can
  still receive a per-turn callback with both halves + a stable id.

**Sacred rules (AGENTS.md):** fail-soft, private mode honored, per-harness contract
changes together, every PR is a release.

## 3. Success criteria (each → a test or a recorded spike result)

Per harness H ∈ {Pi, Hermes}:

1. **Per-turn capture works.** With H's adapter installed + intake enabled, completing
   a turn POSTs a well-formed delta to `/transcript`; the server buffers non-private
   turns; the curator later extracts memories — agent making zero memory calls.
   Verified end-to-end against a local server (as Claude's SC1).
2. **Per-turn private skip.** `[librarian:private=on]` turns are never shipped;
   private-then-public never retroactively ships the private turns (forward-only).
3. **Idempotent + fail-soft.** Re-fire / failed POST never double-creates memories
   (advance-on-ack or server/curator dedup); never blocks or throws in H's runtime.
4. **Default-on, gated, kill-switch.** Capture default-on, suppressed under private
   mode + `LIBRARIAN_AUTO_SAVE=false`, inert when `curator.intake.enabled` is off.
5. **Stable conv_id** keyed per H's session id (never `$USER`/`cwd` — Phase-1 §4.11),
   so concurrent same-machine sessions don't collide.
6. **Shipped + installed by the CLI.** `librarian install <harness>` wires the adapter
   the same way it wires the rest of H's integration.
7. **Honest capability matrix.** `docs/harness-capture-capability.md` updated to the
   proven status for Pi and Hermes — including **BLOCKED with a reason** if a spike fails.
8. **Contracts intact + releasable.** 7-verb surface, drift-guards, `/transcript`
   contract unchanged; gate green; version bump + CHANGELOG.

**Spike gate:** SC1–6 for a harness are only in play *after* its spike (SP-Pi / SP-Hermes)
passes. A failed spike satisfies the spec by recording the harness BLOCKED in the matrix
(SC7) with the specific missing capability — it does not leave the spec unfinished.

## 4. Scope

**In:** capture adapters for **Pi** (TS, `integrations/pi/extensions/librarian`) and
**Hermes** (Python, `integrations/hermes/librarian`), each shipped via its integration +
installer-cli **iff its spike passes**; per-turn private-skip; gate/kill-switch
coherence; the capability-matrix updates (proven status or BLOCKED+reason).

**Out:** Codex, OpenCode, Claude Cowork (→ Phase 2A); changing the `/transcript`
contract, the server pipeline, or the dashboard; active recall-injection / awareness
banners (Phase-1 deferred that for Claude too); Cursor/Antigravity (not Librarian
harnesses).

## 5. Key decisions

1. **Find the per-turn hook ourselves.** No mem0 reference exists; each spike locates
   the harness's per-turn-end event and confirms it hands over the completed turn + a
   stable session id before any adapter is built.
2. **Pi/Hermes: in-payload, no byte cursor.** The §11.2 expectation is that Pi
   (`AgentMessage`) / Hermes (`sync_turn` args) hand the completed turn directly → the
   adapter needs only a seq counter + carried private-span state per conv_id. *(Each
   spike must confirm this; if false, the harness is BLOCKED.)*
3. **Mirror the Claude adapter's shape in the native runtime.** Pi reuses the `lib/*`
   shapes in TS (fetch); Hermes is a parallel Python port (urllib). Same guarantees,
   different language — no shared code across the runtime boundary.
4. **Private-marker handling is adapter-side substring skip** (as Claude + the server
   backstop) — consistent, privacy-safe (Phase-1 Q6).
5. **conv_id per harness, never $USER/cwd** (SC5). Same Phase-1 §4.11 rule as everywhere
   else; concurrent same-machine sessions must not collide.
6. **A failed spike is an acceptable outcome, recorded — not a forced build.** If Pi or
   Hermes has no usable per-turn hook, we mark it BLOCKED with the precise reason and
   stop, rather than shipping a fragile or session-end-only approximation.

## 6. Open questions (the two real spikes)

- **Q-Pi:** does Pi expose a per-turn-end event handing the completed turn in-payload +
  a stable `getSessionId()`? (Pi integration wires only `before_agent_start` today.)
  → **SP-Pi**.
- **Q-Hermes:** does Hermes still invoke `sync_turn(user, assistant)` (or another
  per-turn hook) on a provider that implements it, despite the "retired" no-op?
  → **SP-Hermes**.

## 7. Task plan (spike-gated; each harness = spike → adapter (iff pass) → matrix)

- [ ] **SP-Pi (spike).** Register a `turn_end`/`agent_end` handler in the Pi extension;
      inspect the payload for turn content + the session id. *Accept:* documented shape
      (PASS with the hook + id, or FAIL with what's missing).
- [ ] **T-Pi (on SP pass).** TS adapter in `integrations/pi/extensions/librarian`:
      per-turn hook → delta → private-skip → POST (fetch), fail-soft, gate. Tests.
      Installer wiring. *Accept:* SC1–6 for Pi. *Depends:* SP-Pi.
- [ ] **SP-Hermes (spike).** Implement a throwaway `sync_turn` in a test Hermes provider;
      confirm Hermes calls it with both halves + a stable id. *Accept:* documented
      PASS/FAIL.
- [ ] **T-Hermes (on SP pass).** Python adapter in `integrations/hermes/librarian`:
      per-turn delta, private-skip, POST (urllib), fail-soft, gate. Tests. Installer
      wiring. *Accept:* SC1–6 for Hermes. *Depends:* SP-Hermes.
- [ ] **M-matrix + release.** Update `docs/harness-capture-capability.md` for Pi and
      Hermes to the proven status (or BLOCKED + reason for any failed spike); gate green;
      version bump + CHANGELOG; PR. *Accept:* SC7, SC8.

## 8. Checkpoint

The honest headline: **these two are the genuinely uncertain harnesses** — mem0 doesn't
cover them, so each is a real feasibility spike, not a port. The §11.2 audit expects both
to sit on the "proven floor" (turn in-payload, stable session id), but that's an
expectation to confirm. Run **SP-Pi** and **SP-Hermes** first; each passing spike unlocks
a small, Claude-shaped adapter in the harness's native runtime; a failing spike is
recorded BLOCKED with its reason and that's a complete, honest outcome. Keeping this pair
separate from Phase 2A means their uncertainty never stalls the three proven ports. Hand
a slice to `sdlc-implement` once its spike passes.

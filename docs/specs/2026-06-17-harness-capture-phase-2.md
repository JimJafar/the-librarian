# Spec: harness auto-capture Phase 2 — Pi, Hermes, OpenCode, Codex adapters

**Status:** Proposed — **spike-gated** (each harness's build is gated on a passing
acquisition spike, §7). Written with the `sdlc-spec` method. Phase 2 of
[`2026-06-16-harness-auto-capture.md`](./2026-06-16-harness-auto-capture.md);
Claude (Phase 1) shipped rc.25–29. Re-grounded against `main` (rc.29) — see §2.

## 1. Objective

Extend automatic capture from Claude to the other harnesses, so every harness an
operator runs feeds durable lessons into the Librarian without the agent being asked.
Each harness gets a **thin acquisition adapter** that ships a per-turn conversation
**delta** to the **existing** server endpoint `POST /transcript` (built in rc.24),
mirroring the Claude adapter's guarantees. The server pipeline (buffer → settle-sweep
→ extractor → curator) is unchanged; only the per-harness client differs.

## 2. Grounded facts (re-verified against rc.29)

**The contract every adapter targets** (`packages/mcp-server/src/http/transcript-intake.ts`):
`POST <origin>/transcript`, `Authorization: Bearer ${LIBRARIAN_AGENT_TOKEN}`, body
`{ conv_id: string, harness: string, seq: int≥0, turns: [{role:"user"|"assistant", text, ts?}], ended?: bool }`.
Server redacts on intake, drops `[librarian:private=on]` turns (backstop), gates on
`curator.intake.enabled` (off → `{accepted:false, disabled:true}`, nothing buffered),
hard-caps the buffer. **This contract is fixed; Phase 2 does not change it.**

**The reference adapter** (`integrations/claude/scripts/lib/{capture,cursor,post,transcript}.mjs`):
its guarantees — a per-turn delta, **per-turn `[private=on]` skip** (forward-only),
**advance-on-ack idempotency** (cursor advances only on a 2xx; re-ship is dedup'd
server-side), **fail-soft** (never blocks/throws, errors → a sidecar log), token
in-header + `redirect:error`. Claude is driven by **`UserPromptSubmit`** (the Claude
`Stop`-hook bug #29767), with `Stop`/`SessionEnd` supplementary.

**RE-GROUNDING — the 2026-06-05 capability audit (brainstorm §2.7/§11.2) was
OPTIMISTIC; current `main` does not match it.** This is the load-bearing correction:

| Harness | 2026-06-05 audit said | **Actual state on `main`** |
|---|---|---|
| **Pi** | "feasible, no spike — `turn_end`/`agent_end` hands the turn in-payload" | Integration wires only `before_agent_start` (→ `systemPrompt`, NOT turn content). **No `turn_end`/`agent_end` wired; that event + its in-payload turn shape are UNVERIFIED.** |
| **Hermes** | "cleanest — `sync_turn(user,assistant)` in-payload, no spike" | `provider.py` marks `sync_turn` an **"explicit no-op (retired)"**. **Unconfirmed whether Hermes still CALLS it if a provider implements it.** |
| **OpenCode** | "feasible-with-caveats" | **Config-only; ZERO adapter code.** A capture plugin must be **built from scratch**; `session.idle` bracketing semantics + the plugin event API are unverified. |
| **Codex** | "blocked — no stable conv_id" | Confirmed **BLOCKED**: `cwd`-keyed, `CODEX_RUN_ID` env-only/post-first-turn → two convs in one cwd collide. |

**Conclusion:** there is no "proven floor." Every harness needs a **spike** to confirm
its per-turn acquisition surface actually exists + delivers turn content **before** the
adapter is worth building. The spec is structured spike-first.

**Sacred rules (AGENTS.md):** fail-soft, private mode honored, the per-harness
contract changes together with the others, every PR is a release.

## 3. Success criteria (each → a test or a recorded spike result)

Per harness H ∈ {Pi, Hermes, OpenCode} (Codex is SC7):

1. **Spike recorded.** A maintainer-run spike confirms (or refutes) that H fires a
   per-turn event delivering the completed turn(s) (in-payload or via a readable
   transcript) with a **stable conv_id**. Result documented in the capability matrix.
   *Build of H proceeds only if the spike PASSES.*
2. **Per-turn capture works.** With H's adapter installed + intake enabled, completing
   a turn POSTs a well-formed delta to `/transcript`; the server buffers the
   non-private turns; the curator later extracts memories — agent making zero memory
   calls. Verified end-to-end against a local server (as Claude's SC1).
3. **Per-turn private skip.** Turns under `[librarian:private=on]` are never shipped;
   private-then-public never retroactively ships the private turns (forward-only).
4. **Idempotent + fail-soft.** Re-firing / a failed POST never double-creates memories
   (advance-on-ack or server/curator dedup) and never blocks or throws in H's runtime.
5. **Default-on, gated, kill-switch.** Capture runs by default, suppressed under
   private mode + `LIBRARIAN_AUTO_SAVE=false`, and is inert (server refuses) when
   `curator.intake.enabled` is off — same coherence as Claude.
6. **Shipped + installed by the CLI.** `librarian install <harness>` wires the capture
   adapter the same way it wires the rest of that harness's integration.
7. **Codex documented as blocked.** The capability matrix + Codex README state the
   blocker (no stable conv_id) and the condition to revisit (upstream stable id); no
   adapter is shipped.
8. **Honest capability matrix.** `docs/harness-capture-capability.md` updated per
   harness with the spike outcome (authoritative / feasible / blocked) — no row claims
   capture that the spike didn't prove.
9. **Contracts intact + releasable.** 7-verb surface, drift-guards, `/transcript`
   contract unchanged; gate green; version bump + CHANGELOG.

## 4. Scope

**In:** acquisition-spike + (on pass) a capture adapter for **Pi, Hermes, OpenCode**,
each shipped via its integration + the installer-cli; the per-turn private-skip;
gate/kill-switch coherence; the capability-matrix updates. The shared adapter *logic*
(private-span filter, payload build, seq, advance-on-ack) ported per-harness — reuse
the Claude `lib/*` shapes where the runtime allows (Pi/OpenCode are Node/TS; Hermes is
Python — a parallel implementation).

**Out:**
- **Codex** capture (BLOCKED — documented only). A degraded per-cwd capture is
  explicitly **not** built (it loses per-conversation attribution; the privacy/dedup
  cost isn't worth it).
- Any change to the `/transcript` contract, the server pipeline, or the dashboard.
- Active recall-injection / awareness banners for these harnesses (Phase 1 deferred
  that for Claude too; out of scope here).

## 5. Key decisions + assumptions to confirm

1. **Spike-first, per harness.** The audit's readiness was assumption, not fact.
   Each harness's build is gated on a passing spike (§7). If a spike refutes the
   surface (e.g. Hermes never calls `sync_turn`), that harness is re-classified and
   deferred, not forced.
2. **In-payload harnesses skip the byte-offset cursor.** Pi (`AgentMessage`) and
   Hermes (`sync_turn` args) hand the completed turn directly — so the adapter needs
   only a **seq counter + carried private-span state** per conv_id (a tiny cursor),
   not Claude's transcript byte-offset. OpenCode (accumulate-by-id, flush on idle) is
   in between. *(Assumption to confirm in each spike.)*
3. **Reuse the Claude logic shape, re-implement per runtime.** Pi/OpenCode (TS) can
   share a small `lib/` mirroring Claude's `transcript.mjs` private-filter +
   `post.mjs`; Hermes (Python) is a parallel port. The *contract* + *guarantees* are
   identical; the code is per-runtime.
4. **Private-marker handling is adapter-side substring match** (as Claude + the server
   backstop) — consistent, privacy-safe (Phase-1 Q6).
5. **conv_id per harness:** Pi `getSessionId()`, Hermes configured `session_id`,
   OpenCode `sessionID`. *(Each confirmed in its spike; this is the keying that makes
   concurrent same-machine sessions safe — Phase-1 §4.11.)*
6. **Order = cleanest-first, and fail fast.** Hermes (lowest effort *if* the spike
   passes) → Pi → OpenCode (highest effort, build-from-scratch). Codex is a doc task.

## 6. Open questions (the gating spikes — a human/maintainer must answer)

- **Q-Pi:** Does Pi expose a per-turn-end event (`turn_end`/`agent_end` or similar)
  that hands the completed user+assistant turn **in-payload**, and a stable session
  id? (Audit assumed yes; integration doesn't wire it.) → spike **SP-Pi**.
- **Q-Hermes:** Does Hermes still **invoke** `sync_turn(user, assistant)` (or another
  per-turn hook delivering both halves) on a provider that implements it, despite the
  "retired" no-op? → spike **SP-Hermes**.
- **Q-OpenCode:** Does the OpenCode plugin API expose per-message/`session.idle`
  events to a plugin, and does `session.idle` bracket exactly one settled
  conversation (not every idle moment)? → spike **SP-OpenCode**.
- **Q-Codex (revisit trigger):** Has Codex shipped a stable per-conversation id yet?
  If yes, Codex re-enters scope. (Currently no.)

## 7. Task plan (spike-gated; each harness = spike → adapter → matrix)

Spikes are maintainer-run (they need the real harness installed); the adapter build
follows only on a PASS. Order: fail-fast on the cheapest, build cleanest-first.

### Per-harness slices

- [ ] **SP-Hermes (spike).** Implement a throwaway `sync_turn`/per-turn hook in a test
      Hermes provider; confirm Hermes calls it with both turn halves + a stable id.
      *Accept:* documented PASS/FAIL + the event shape. *(Cheapest; do first.)*
- [ ] **T-Hermes (on SP pass).** Python adapter in `integrations/hermes/librarian`: on
      each turn, build the delta, per-turn private-skip, POST to `/transcript`
      (urllib), fail-soft, gate/kill-switch. Tests (mock server). Installer wires it.
      *Accept:* SC1–6 for Hermes. *Depends:* SP-Hermes.
- [ ] **SP-Pi (spike).** Register a `turn_end`/`agent_end` handler in the Pi extension;
      inspect the event payload (does it carry the completed turn prose?) + the session
      id. *Accept:* documented PASS/FAIL + payload shape. *Depends:* none.
- [ ] **T-Pi (on SP pass).** TS adapter in `integrations/pi/extensions/librarian`:
      per-turn hook → delta → private-skip → POST (fetch), fail-soft, gate. Tests.
      Installer wiring. *Accept:* SC1–6 for Pi. *Depends:* SP-Pi.
- [ ] **SP-OpenCode (spike).** Research the OpenCode plugin API; build a minimal plugin
      that logs message/`session.idle` events; confirm idle brackets one settled
      conversation + a stable `sessionID`. *Accept:* documented PASS/FAIL + the
      accumulate-by-id + flush model. *Depends:* none. *(Riskiest — from scratch.)*
- [ ] **T-OpenCode (on SP pass).** New TS plugin: accumulate turns by id, flush on
      idle → delta → private-skip → POST, fail-soft, gate; shipped + installer-wired.
      Tests. *Accept:* SC1–6 for OpenCode. *Depends:* SP-OpenCode.
- [ ] **D-Codex (doc).** Record Codex as BLOCKED in the capability matrix + Codex
      README with the revisit condition (upstream stable conv_id). No code.
      *Accept:* SC7. *Depends:* none.
- [ ] **M-matrix + release.** Update `docs/harness-capture-capability.md` per harness
      to the proven status; gate green; version bump + CHANGELOG; PR. *Accept:* SC8,
      SC9. *Depends:* the above.

## 8. Checkpoint

The honest headline for review: **Phase 2 is spike-gated, not shovel-ready** — the
prior "Pi/Hermes are a proven floor" was an assumption the current code doesn't bear
out. The cheap, decisive next step is **SP-Hermes** and **SP-Pi** (small throwaway
hooks on the real harnesses); their results decide whether those adapters are a
half-day each or a deferral. OpenCode is a genuine from-scratch plugin. Codex stays
blocked. Nothing here should be handed to `sdlc-implement` until the relevant spike
passes — that's the gate.

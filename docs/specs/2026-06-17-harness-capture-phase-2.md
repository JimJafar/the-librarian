# Spec: harness auto-capture Phase 2 — Pi, Hermes, OpenCode, Codex adapters

**Status:** Proposed. Written with the `sdlc-spec` method. Phase 2 of
[`2026-06-16-harness-auto-capture.md`](./2026-06-16-harness-auto-capture.md); Claude
(Phase 1) shipped rc.25–29. **Reference point: mem0's shipping plugin** — it already
does automatic capture for Claude, Codex, OpenCode, Cursor, and Antigravity, so for
the harnesses it covers we port its *proven* approach rather than re-deriving
feasibility. Grounded against `main` (rc.29) and mem0's plugin source.

## 1. Objective

Extend automatic capture from Claude to the other harnesses, so every harness an
operator runs feeds durable lessons into the Librarian without the agent being asked.
Each harness gets a **thin acquisition adapter** that ships a per-turn conversation
**delta** to the **existing** `POST /transcript` endpoint (rc.24), mirroring the
Claude adapter's guarantees. The server pipeline (buffer → settle-sweep → extractor →
curator) is unchanged; only the per-harness client differs.

## 2. Grounded facts

**The contract every adapter targets** (`packages/mcp-server/src/http/transcript-intake.ts`):
`POST <origin>/transcript`, `Bearer ${LIBRARIAN_AGENT_TOKEN}`, body
`{ conv_id, harness, seq, turns:[{role,text,ts?}], ended? }`; server redacts, drops
`[private=on]` turns, gates on `curator.intake.enabled`, hard-caps the buffer. **Fixed.**

**The reference adapter** (`integrations/claude/scripts/lib/{capture,cursor,post,transcript}.mjs`):
per-turn delta, per-turn `[private=on]` skip (forward-only), advance-on-ack idempotency,
fail-soft, token-in-header + `redirect:error`; triggered by `UserPromptSubmit` (Claude
`Stop`-bug #29767) with `Stop`/`SessionEnd` supplementary.

**mem0 is the proven cross-harness reference** (re-read from source, `/tmp/mem0-probe/integrations/mem0-plugin`):

- **Codex** (`hooks/codex-hooks.json`, `scripts/install_codex_hooks.py`): mem0 wires
  Codex with the **same command-hook events as Claude** — `SessionStart`,
  `UserPromptSubmit`, `Stop`, `PreCompact`, `PreToolUse`, `PostToolUse`. Codex has **no
  plugin host**, so hooks are installed by **merging into `~/.codex/hooks.json`**
  (idempotent, scoped by an owner marker in the command string) and require a
  `codex_hooks = true` flag in `~/.codex/config.toml`. **→ Codex is NOT blocked; it has
  Claude's exact acquisition surface.**
- **OpenCode** (`.opencode-plugin/opencode-mem0.ts`, ~750 lines): a real TS plugin
  (`@opencode-ai/plugin`). Capture rides the **`chat.message`** hook (`extractUserText`
  pulls prose from `output.parts`); the full message list is available via
  `experimental.chat.messages.transform`; `experimental.session.compacting` gives a
  session summary; `shell.env` injects identity. **→ OpenCode capture is `chat.message`,
  NOT the `session.idle`-bracketing the 2026-06-05 audit guessed.**
- mem0 does **not** cover **Pi** or **Hermes** (Librarian-specific harnesses) — no
  external reference; we find their per-turn hook ourselves, applying the same pattern.

**Correction to the 2026-06-05 audit (and to the first draft of this spec):** that
audit called Codex "blocked" and OpenCode "feasible-with-caveats / idle-bracketing."
mem0's source shows Codex has Claude's hooks and OpenCode capture is `chat.message`.
The conservative framing was wrong; this spec ports mem0's proven approach.

**Sacred rules (AGENTS.md):** fail-soft, private mode honored, per-harness contract
changes together, every PR is a release.

## 3. Success criteria (each → a test or a recorded spike result)

Per harness H ∈ {Codex, OpenCode, Pi, Hermes}:

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
   so concurrent same-machine sessions don't collide. (Note: mem0 keys by a *generated*
   per-USER id — a bug we explicitly avoid, since we hit it with Claude.)
6. **Shipped + installed by the CLI.** `librarian install <harness>` wires the adapter
   the same way it wires the rest of H's integration.
7. **Honest capability matrix.** `docs/harness-capture-capability.md` updated to the
   proven status per harness.
8. **Contracts intact + releasable.** 7-verb surface, drift-guards, `/transcript`
   contract unchanged; gate green; version bump + CHANGELOG.

## 4. Scope

**In:** capture adapters for **Codex, OpenCode, Pi, Hermes**, each shipped via its
integration + installer-cli; per-turn private-skip; gate/kill-switch coherence; the
capability-matrix updates. Reuse the Claude adapter where the runtime matches (Codex
is command-hooks → reuse `on-stop.mjs`; Pi/OpenCode are TS → reuse the `lib/*` shapes;
Hermes is Python → parallel port).

**Out:** changing the `/transcript` contract, the server pipeline, or the dashboard;
active recall-injection / awareness banners for these harnesses (Phase-1 deferred that
for Claude too); Cursor/Antigravity (not Librarian harnesses).

## 5. Key decisions

1. **Port mem0's proven approach where it exists** (Codex, OpenCode); find the
   equivalent per-turn hook for the Librarian-specific harnesses (Pi, Hermes).
2. **Codex reuses the Claude adapter.** Codex fires the same `UserPromptSubmit`/`Stop`
   hooks; if its payload carries `transcript_path` + a session/run id (the one spike),
   the existing `on-stop.mjs` + `lib/*` run almost as-is. Install via a Codex hooks
   merger mirroring mem0's `install_codex_hooks.py` (merge into `~/.codex/hooks.json`,
   owner-marker idempotent, surface the `codex_hooks=true` flag requirement).
3. **OpenCode is a `chat.message` TS plugin** modeled on mem0's `opencode-mem0.ts` —
   capture each turn from the message parts, `conv_id = sessionID`, POST to
   `/transcript`. NOT `session.idle` bracketing.
4. **Pi/Hermes: in-payload, no byte cursor.** Pi (`AgentMessage`) / Hermes
   (`sync_turn` args) hand the completed turn directly → the adapter needs only a seq
   counter + carried private-span state per conv_id. *(Confirmed by each spike.)*
5. **Private-marker handling is adapter-side substring skip** (as Claude + the server
   backstop) — consistent, privacy-safe (Phase-1 Q6).
6. **conv_id per harness, never $USER/cwd** (SC5). We explicitly do NOT copy mem0's
   per-USER `/tmp` session-id file (it clobbers concurrent sessions — we hit exactly
   that bug on Claude, §4.11 of Phase 1).

## 6. Open questions (the remaining spikes — small, mostly payload-shape confirmations)

- **Q-Codex (the one real unknown for Codex):** does the Codex `UserPromptSubmit`/`Stop`
  hook payload include `transcript_path` + a stable session/run id (`CODEX_RUN_ID`?)
  for `conv_id`? If yes → reuse `on-stop.mjs` directly. If only `cwd` → key by the
  transcript filename or `CODEX_RUN_ID`; degrade gracefully. → **SP-Codex**.
- **Q-OpenCode:** confirm `chat.message` delivers both user and assistant turns (or that
  the message list does), and `sessionID` is stable — both visible in mem0's plugin but
  re-verify against the current `@opencode-ai/plugin` API. → **SP-OpenCode** (low risk).
- **Q-Pi:** does Pi expose a per-turn-end event handing the completed turn in-payload +
  a stable `getSessionId()`? (No mem0 ref; Pi integration wires only
  `before_agent_start` today.) → **SP-Pi**.
- **Q-Hermes:** does Hermes still invoke `sync_turn(user, assistant)` (or another
  per-turn hook) on a provider that implements it, despite the "retired" no-op? → **SP-Hermes**.

## 7. Task plan (port-proven-first; each harness = small spike → adapter → matrix)

Ordered by confidence/effort: Codex (reuse the existing adapter) and OpenCode (port
mem0) first — they have proven references; Pi/Hermes need a per-turn-hook spike.

- [ ] **SP-Codex (spike).** Install the Claude `UserPromptSubmit`/`Stop` hook into a
      test `~/.codex/hooks.json` (codex_hooks flag on); inspect the payload — does it
      carry `transcript_path` + an id? *Accept:* documented payload shape. *Cheapest.*
- [ ] **T-Codex (on SP pass).** Wire `on-stop.mjs` (reused/adapted for the Codex
      payload + conv_id source) via a Codex hooks installer (mirror
      `install_codex_hooks.py`: merge into `~/.codex/hooks.json`, owner-marker
      idempotent, flag hint) in `integrations/codex/` + `installer-cli/harnesses/codex.ts`.
      Tests. *Accept:* SC1–6 for Codex. *Depends:* SP-Codex.
- [ ] **T-OpenCode.** New TS plugin (port mem0's `opencode-mem0.ts` capture path):
      `chat.message` → build delta from the turn → per-turn private-skip → POST to
      `/transcript`, `conv_id=sessionID`, fail-soft, gate; shipped under
      `integrations/opencode/` + installer-wired. Tests. *Accept:* SC1–6 for OpenCode.
      *Depends:* SP-OpenCode (low-risk confirm).
- [ ] **SP-Hermes (spike).** Implement a throwaway `sync_turn` in a test Hermes
      provider; confirm Hermes calls it with both halves + a stable id. *Accept:*
      documented PASS/FAIL.
- [ ] **T-Hermes (on SP pass).** Python adapter in `integrations/hermes/librarian`:
      per-turn delta, private-skip, POST (urllib), fail-soft, gate. Tests. Installer
      wiring. *Accept:* SC1–6 for Hermes. *Depends:* SP-Hermes.
- [ ] **SP-Pi (spike).** Register a `turn_end`/`agent_end` handler in the Pi extension;
      inspect the payload for turn content + the session id. *Accept:* documented shape.
- [ ] **T-Pi (on SP pass).** TS adapter in `integrations/pi/extensions/librarian`:
      per-turn hook → delta → private-skip → POST (fetch), fail-soft, gate. Tests.
      Installer wiring. *Accept:* SC1–6 for Pi. *Depends:* SP-Pi.
- [ ] **M-matrix + release.** Update `docs/harness-capture-capability.md` per harness to
      the proven status; gate green; version bump + CHANGELOG; PR. *Accept:* SC7, SC8.

## 8. Checkpoint

The honest, mem0-grounded headline: **Codex and OpenCode are de-risked by mem0's
shipping code** — Codex reuses Claude's adapter (just wire it into `~/.codex/hooks.json`),
OpenCode is a `chat.message` plugin ported from `opencode-mem0.ts`. Only **Pi** and
**Hermes** (which mem0 doesn't cover) need a real per-turn-hook spike. The cheapest
decisive step is **SP-Codex** (reuse what's built; confirm the payload). Each spike is
a small confirmation, not a feasibility gamble. Hand a slice to `sdlc-implement` once
its spike passes.

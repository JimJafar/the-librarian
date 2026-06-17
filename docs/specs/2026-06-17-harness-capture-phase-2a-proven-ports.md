# Spec: harness auto-capture Phase 2A — proven ports (Codex, OpenCode, Claude Cowork)

**Status:** Proposed. Written with the `sdlc-spec` method. Phase 2A of
[`2026-06-16-harness-auto-capture.md`](./2026-06-16-harness-auto-capture.md); Claude
(Phase 1) shipped rc.25–29. **This spec covers only the three harnesses mem0's shipping
plugin already proves** — Codex, OpenCode, and Claude Cowork. The two Librarian-specific
harnesses with no external reference (Pi, Hermes) are split into
[`2026-06-17-harness-capture-phase-2b-spike-gated.md`](./2026-06-17-harness-capture-phase-2b-spike-gated.md)
so their feasibility spikes don't gate this confident, buildable work. Grounded against
`main` (rc.29) and mem0's plugin source.

## 1. Objective

Extend automatic capture from Claude to **Codex, OpenCode, and Claude Cowork** — the
harnesses mem0 already ships capture for — so every one an operator runs feeds durable
lessons into the Librarian without the agent being asked. Codex and OpenCode each get a
**thin acquisition adapter** that ships a per-turn conversation **delta** to the
**existing** `POST /transcript` endpoint (rc.24), mirroring the Claude adapter's
guarantees. The server pipeline (buffer → settle-sweep → extractor → curator) is
unchanged; only the per-harness client differs.

**Claude Cowork is the exception — not a new adapter at all.** Cowork (Anthropic's
desktop app) shares Claude Code's plugin system, so the **same `integrations/claude/`
plugin** (hooks + `on-stop.mjs`) is already its acquisition surface. Cowork is a
**verify-and-document** task: confirm the desktop plugin host fires our per-turn hooks
and supplies a usable `conv_id`, then document the GUI install path. Zero new capture
code in the happy case.

## 2. Grounded facts

**The contract every adapter targets** (`packages/mcp-server/src/http/transcript-intake.ts`):
`POST <origin>/transcript`, `Bearer ${LIBRARIAN_AGENT_TOKEN}`, body
`{ conv_id, harness, seq, turns:[{role,text,ts?}], ended? }`; server redacts, drops
`[private=on]` turns, gates on `curator.intake.enabled`, hard-caps the buffer. **Fixed.**

**The reference adapter** (`integrations/claude/scripts/lib/{capture,cursor,post,transcript}.mjs`):
per-turn delta, per-turn `[private=on]` skip (forward-only), advance-on-ack idempotency,
fail-soft, token-in-header + `redirect:error`; triggered by `UserPromptSubmit` (Claude
`Stop`-bug #29767) with `Stop`/`SessionEnd` supplementary.

**mem0 is the proven reference for all three** (re-read from source,
`/tmp/mem0-probe/integrations/mem0-plugin`):

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
- **Claude Cowork** (`README.md` §"Claude Code (CLI) / Claude Cowork (Desktop)"): mem0
  ships **one** plugin for both — "Claude Code and Claude Cowork share the same plugin
  system." The same install delivers "the MCP server, lifecycle hooks (automatic memory
  capture), and the skill." Cowork's install is the desktop GUI (Customize → Browse
  plugins → Mem0), not a CLI command. **→ Cowork reuses the Claude plugin verbatim; only
  the install surface and a desktop hook-firing check differ.**

**Correction to the 2026-06-05 audit (and the first draft of the combined Phase-2 spec):**
that audit called Codex "blocked" and OpenCode "feasible-with-caveats / idle-bracketing."
mem0's source shows Codex has Claude's hooks and OpenCode capture is `chat.message`. The
conservative framing was wrong; this spec ports mem0's proven approach.

**Sacred rules (AGENTS.md):** fail-soft, private mode honored, per-harness contract
changes together, every PR is a release.

## 3. Success criteria (each → a test or a recorded spike result)

Per harness H ∈ {Codex, OpenCode}:

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
   proven status for Codex, OpenCode, and Cowork.
8. **Contracts intact + releasable.** 7-verb surface, drift-guards, `/transcript`
   contract unchanged; gate green; version bump + CHANGELOG.

**For Claude Cowork (reused adapter, not a new one):** SC1–5 are *inherited* from the
shipped Claude adapter — the success bar is **re-verifying** them on the desktop host,
not re-building them: a turn in Cowork POSTs a well-formed delta (SC1), private turns
are skipped (SC2), re-fire/failure is idempotent + fail-soft (SC3), the gate +
kill-switch hold (SC4), and `conv_id` is stable + collision-safe on the desktop payload
(SC5). SC6 becomes **"install is documented for the Cowork GUI"** (Customize → Browse
plugins), since Cowork has no `claude` CLI to drive. SC7 (matrix) and SC8 (releasable)
apply as written.

## 4. Scope

**In:** capture adapters for **Codex** and **OpenCode**, each shipped via its
integration + installer-cli; per-turn private-skip; gate/kill-switch coherence; the
capability-matrix updates. Reuse the Claude adapter where the runtime matches (Codex is
command-hooks → reuse `on-stop.mjs`; OpenCode is TS → reuse the `lib/*` shapes). Plus
**Claude Cowork** as a verify-and-document item: confirm the existing Claude plugin
captures on the desktop host, document the GUI install, update the matrix — no new
adapter unless the desktop host diverges.

**Out:** Pi and Hermes (→ Phase 2B); changing the `/transcript` contract, the server
pipeline, or the dashboard; active recall-injection / awareness banners for these
harnesses (Phase-1 deferred that for Claude too); Cursor/Antigravity (mem0 covers them
but they're not yet Librarian harnesses — a possible later breadth phase).

## 5. Key decisions

1. **Port mem0's proven approach.** Every harness here has a mem0 reference; we port it
   rather than re-deriving feasibility.
2. **Codex reuses the Claude adapter.** Codex fires the same `UserPromptSubmit`/`Stop`
   hooks; if its payload carries `transcript_path` + a session/run id (the one spike),
   the existing `on-stop.mjs` + `lib/*` run almost as-is. Install via a Codex hooks
   merger mirroring mem0's `install_codex_hooks.py` (merge into `~/.codex/hooks.json`,
   owner-marker idempotent, surface the `codex_hooks=true` flag requirement).
3. **OpenCode is a `chat.message` TS plugin** modeled on mem0's `opencode-mem0.ts` —
   capture each turn from the message parts, `conv_id = sessionID`, POST to
   `/transcript`. NOT `session.idle` bracketing.
4. **Claude Cowork reuses the shipped Claude plugin verbatim — no fork.** Cowork and
   Claude Code share one plugin host, so we ship the *same* `integrations/claude/`
   plugin and treat Cowork as a second runtime to verify, not a new target to build.
   The two things that genuinely differ: (a) **install** is the Cowork desktop GUI, not
   `claude plugin install` — so `librarian install` stays CLI-only and we *document* the
   GUI path (mem0 does the same); (b) the desktop plugin host must actually fire our
   per-turn hooks. If — and only if — the desktop host diverges (different hook firing,
   missing `transcript_path`/session id in the payload, or a Cowork-specific variant of
   Claude bug #29767), we add the smallest shim, never a parallel adapter.
5. **Private-marker handling is adapter-side substring skip** (as Claude + the server
   backstop) — consistent, privacy-safe (Phase-1 Q6).
6. **conv_id per harness, never $USER/cwd** (SC5). We explicitly do NOT copy mem0's
   per-USER `/tmp` session-id file (it clobbers concurrent sessions — we hit exactly
   that bug on Claude, §4.11 of Phase 1).

## 6. Open questions (the remaining spikes — small, mostly payload-shape confirmations)

- **Q-Codex (the one real unknown for Codex):** does the Codex `UserPromptSubmit`/`Stop`
  hook payload include `transcript_path` + a stable session/run id (`CODEX_RUN_ID`?) for
  `conv_id`? If yes → reuse `on-stop.mjs` directly. If only `cwd` → key by the transcript
  filename or `CODEX_RUN_ID`; degrade gracefully. → **SP-Codex**.
- **Q-OpenCode:** confirm `chat.message` delivers both user and assistant turns (or that
  the message list does), and `sessionID` is stable — both visible in mem0's plugin but
  re-verify against the current `@opencode-ai/plugin` API. → **SP-OpenCode** (low risk).
- **Q-Cowork:** with our Claude plugin installed in Cowork, does the **desktop** plugin
  host fire `UserPromptSubmit`/`Stop`/`SessionEnd` and hand `on-stop.mjs` a payload with
  `transcript_path` + a stable session id — i.e. does capture work unchanged, or does the
  desktop host differ (incl. whether Claude bug #29767 manifests there too)? Needs the
  Cowork desktop app to test. → **SP-Cowork**.

## 7. Task plan (port-proven-first; each harness = small spike → adapter → matrix)

- [ ] **SP-Codex (spike).** Install the Claude `UserPromptSubmit`/`Stop` hook into a
      test `~/.codex/hooks.json` (codex_hooks flag on); inspect the payload — does it
      carry `transcript_path` + an id? *Accept:* documented payload shape. *Cheapest.*
- [ ] **T-Codex (on SP pass).** Wire `on-stop.mjs` (reused/adapted for the Codex payload
      + conv_id source) via a Codex hooks installer (mirror `install_codex_hooks.py`:
      merge into `~/.codex/hooks.json`, owner-marker idempotent, flag hint) in
      `integrations/codex/` + `installer-cli/harnesses/codex.ts`. Tests. *Accept:* SC1–6
      for Codex. *Depends:* SP-Codex.
- [ ] **T-OpenCode.** New TS plugin (port mem0's `opencode-mem0.ts` capture path):
      `chat.message` → build delta from the turn → per-turn private-skip → POST to
      `/transcript`, `conv_id=sessionID`, fail-soft, gate; shipped under
      `integrations/opencode/` + installer-wired. Tests. *Accept:* SC1–6 for OpenCode.
      *Depends:* SP-OpenCode (low-risk confirm).
- [ ] **SP-Cowork (spike, needs the desktop app).** Install the shipped Claude plugin in
      Cowork; run a few turns with intake enabled; check `capture.log` + the server buffer
      for a well-formed delta. Confirm which hooks fire and whether the payload carries
      `transcript_path` + a session id. *Accept:* documented PASS (capture works unchanged)
      or the precise divergence. *Independent of Codex/OpenCode — run whenever a Cowork
      install is available.*
- [ ] **T-Cowork (on SP pass).** Mostly docs: add a Cowork GUI-install section to
      `integrations/claude/README.md` (mirror mem0's Customize → Browse plugins flow) and
      a capability-matrix row; if SP-Cowork found a divergence, add the smallest shim in
      `on-stop.mjs`/`lib/*` (guarded, fail-soft) — never a parallel adapter. Tests only if
      a shim lands. *Accept:* SC1–5 re-verified on Cowork, SC6 = GUI install documented.
      *Depends:* SP-Cowork.
- [ ] **M-matrix + release.** Update `docs/harness-capture-capability.md` for Codex,
      OpenCode, and Cowork to the proven status; gate green; version bump + CHANGELOG;
      PR. *Accept:* SC7, SC8.

## 8. Checkpoint

The honest, mem0-grounded headline: **all three harnesses here are de-risked by mem0's
shipping code** — Codex reuses Claude's adapter (just wire it into `~/.codex/hooks.json`),
OpenCode is a `chat.message` plugin ported from `opencode-mem0.ts`, and **Cowork is the
lowest-code of all: the same Claude plugin we already ship, verified on the desktop host
and documented for the GUI install** (no new adapter in the happy case). The cheapest
decisive step is **SP-Codex** (reuse what's built; confirm the payload); **SP-Cowork** is
the cheapest in *code* but gated on having the desktop app to test. Each spike is a small
confirmation, not a feasibility gamble. Hand a slice to `sdlc-implement` once its spike
passes. The genuinely uncertain harnesses (Pi, Hermes) are in Phase 2B so they can't
stall this work.

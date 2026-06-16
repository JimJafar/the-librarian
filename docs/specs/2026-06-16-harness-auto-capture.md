# Spec: harness-driven automatic capture + awareness injection (ADR 0009)

**Status:** Phase 1 **ready to build**, Claude Code first — pending
[ADR 0009](../adr/0009-integration-enforced-librarian-use.md) acceptance on merge.
Written with the `sdlc-spec` method. Grounded against ADR 0009 and the 2026-06-05
working doc `docs/research/harness-driven-capture-brainstorm.md` (idea A capture,
idea B awareness; decisions D6/D7/D8/D9/D10; the §11.2 per-harness capability
audit). Supersedes and replaces `2026-06-14-integration-guardrails.md` (the broad
file-write veto — demoted to the narrow block here).

## 1. Objective

Make the Librarian the thing an agent's memory actually flows through, **without
relying on the agent to remember to call the verbs** — starting with the one
harness the owner uses daily (Claude Code). Two paired moves, plus a guard:

- **Capture** durable lessons **automatically and deterministically** — a hook
  ships the conversation to the server, which extracts facts via the existing
  curator. Zero agent tokens, zero agent decisions.
- **Awareness** — deterministically remind the agent it *has* `recall`/`remember`
  and prompt it to recall when prior context may exist (especially post-compaction).
- **Narrow block** — stop the agent fleeing to the one competing channel (the
  native `MEMORY.md` store), and nothing broader.

The primer already *tells* agents to use the Librarian; that has been shown
insufficient (ADR 0009 Context). This adds the automation the primer can't be.

Grounded facts this builds on:

- The intake → curator engine already mines **arbitrary raw text** server-side:
  `remember` → `submitToInbox(text, hints)` → `inbox/<ts>-<id>.md` → the intake
  sweep → navigate → judge → apply (create/augment/supersede/archive/noop) with
  confidence bands. **This is the extraction engine** — capture adds a *door and a
  settle-sweep in front of it*, not a new extractor (brainstorm §2.2, §2.x).
- Today there is **no HTTP transcript-intake surface**. The **public** listener
  serves `/healthz`, `/primer.md`, `/mcp` (agent auth: `Bearer ${LIBRARIAN_AGENT_TOKEN}`);
  `/trpc/*` moved to an **internal-only** listener (ADR 0008, landed). The new
  `POST /transcript` is an agent-facing **public-listener** route using that same
  agent-token auth. No server-side `learn` tool — `/learn` drives the *agent*
  (brainstorm §2.1, §2.6).
- The intake sweep is gated by **`curator.intake.enabled`** (a dashboard setting,
  self-checked in the intake tick via `isIntakeEnabled(store)`; the legacy
  `LIBRARIAN_CONSOLIDATOR` env now only *seeds* it). Secret redaction reuses
  **`redactSecrets(text)`** (`grooming-redaction.ts`). *(§1 facts re-grounded vs
  rc.22, 2026-06-16.)*
- The Claude Code integration today ships `.mcp.json`, the plugin manifest, four
  slash commands, a README — and **no hooks**. Claude plugins *can* ship hooks via
  the plugin's own `hooks/hooks.json` (the marketplace install wires them) — so
  Phase 1 needs **no** dependency on the not-yet-built installer-cli.
- **Private mode is a pure in-conversation marker** (`[librarian:private=on|off]`)
  with **no server-side state** a hook can read (brainstorm §2.5). The capture path
  therefore reads the marker **from the transcript it is already reading** and skips
  private turns per-turn.
- Sacred rules (AGENTS.md §2): **fail-soft** (never block the user's turn), **private
  mode** (no writes; never bypass), the **7-verb surface** + drift-guards
  (untouched), **cross-harness contracts change together**, **every PR is a release**.

## 2. Success criteria

The acceptance bar; each becomes a test. (Claude Code unless noted.)

1. **Automatic capture round-trip.** With the plugin installed and
   `LIBRARIAN_AUTO_SAVE` unset (default-on), completing a substantial turn lands the
   turn's text in the server buffer; when the conversation settles, one curator pass
   runs and durable facts appear as memories (high-confidence) or proposals
   (low-confidence) — with the **agent making zero memory calls**. Verified
   end-to-end against a local server.
2. **Incremental + idempotent.** The cursor advances **only on server ack**; a
   dropped/failed POST re-ships on the next turn; re-shipped deltas do **not**
   create duplicate memories (the curator dedups). Verified by simulating a failed
   POST then a recovery turn.
3. **Durable across an abrupt end.** Ending the session after N turns (no clean
   stop, `/clear`, or app-close) still results in those turns' facts being extracted
   — the **server settle-sweep fires on idle**, needing no end event; at most the
   last un-acked turn is lost. Verified by ending without a clean stop.
4. **Private-mode per-turn skip.** Turns under `[librarian:private=on]` are **never
   shipped**; a private-then-public sequence **never retroactively ships** the
   private turns (forward-only cursor + per-turn skip). The buffer and curator never
   see a private turn. Verified with a private-span fixture (covers brainstorm
   Scenarios B & C).
5. **Redaction on intake.** Secrets in a captured turn are redacted **before** the
   buffer file is written — no secret reaches the sidecar in clear, the inbox, or
   any git history. Verified with a secret-shaped fixture (brainstorm D6, Scenario D).
6. **Sidecar hygiene.** The buffer lives **outside the git vault**, is gitignored,
   is atomically claimed (`→ .processing`) before extraction, and **deleted after**;
   an orphaned `.processing` is reaped. Verified.
7. **Kill-switch + gate coherence.** `LIBRARIAN_AUTO_SAVE=false` ⇒ nothing ships and
   nothing buffers. Capture intake and the curator sweep are gated **coherently** —
   capture never buffers into an inbox nothing will sweep (resolves brainstorm I5).
   Verified by toggling each gate.
8. **Narrow write-block.** A `Write`/`Edit`/`MultiEdit` to `**/.claude/**/memory/**`
   or its `MEMORY.md` is **blocked** with a teaching message naming `remember`;
   ordinary writes (source, `docs/**`, `vault/primer.md`) are **not** blocked; the
   guard **fails open** on its own error. Verified against a must-block / must-allow
   fixture set.
9. **Awareness injection + status banner.** At conversation start the agent receives
   a deterministic, server-sourced Librarian banner — it has `recall`/`remember`, plus
   the current **capture status**. When capture is disabled (curator off server-side,
   or `LIBRARIAN_AUTO_SAVE=false`) the banner **warns** and names the reason + fix.
   The awareness nudge **survives compaction** and is visible/auditable. Verified for
   the active state and both disabled states.
10. **Fail-soft everywhere.** Any capture / guard / extraction error never blocks the
    user's turn, never leaks a stack trace into the model's context, and is logged to
    the local sidecar. On **any uncertainty**, the capture path errs toward **not**
    capturing. Verified by inducing errors at each stage.
11. **Uniform contract.** The server transcript-intake endpoint accepts a
    **harness-agnostic** delta payload (`conv_id`, `harness`, sequence, `turns[]`,
    `ended?`); the Claude adapter is the first consumer; a second (mock) harness
    payload validates against the same contract. Verified by a contract test.
12. **Shipped via the plugin.** The Claude hooks ship in
    `integrations/claude/hooks/hooks.json` + `scripts/`; `/plugin install` wires
    them; uninstall removes them. No machine hand-editing. (Installer-cli
    integration is later/orthogonal.)
13. **Contracts intact + releasable.** 7-verb surface, protocol docs, drift-guards
    unchanged; `pnpm test` / `typecheck` / `lint` green; PR bumps root version +
    dated CHANGELOG (`check:release`).
14. **Honest capability matrix.** A documented per-harness table (capture mechanism,
    conv_id stability, status) seeded: Claude = authoritative (pending the §6 live
    test); Pi/Hermes = feasible (in-payload); OpenCode = feasible-with-caveats;
    Codex = blocked (no stable conv_id).
15. **Concurrent same-machine sessions.** With **N Claude sessions running at once on
    one machine — including multiple in the same repo/cwd** — each captures
    independently: no cross-session clobbering of cursors, buffers, counters, or
    private state. Verified with ≥2 concurrent sessions in one cwd — distinct
    `session_id`s ⇒ distinct cursors and distinct `transcripts/<conv_id>.md` buffers,
    and a `[private=on]` toggle in one session does not affect the other.

## 3. Scope

**Phase 1 (in) — the server pipeline + the Claude adapter, dogfooded:**

- **Server (harness-agnostic, built once):** the transcript-intake endpoint + the
  uniform payload contract; redaction-on-intake; the per-conversation sidecar buffer;
  the settle-sweep (idle / size / explicit-end) + reaper; the **extractor** (one
  curator pass over the settled buffer → existing inbox → curator with confidence
  bands); gate coherence with the existing sweep.
- **Claude acquisition adapter:** the `Stop` hook (tail `transcript_path` from a
  byte-offset cursor, per-turn private skip, POST the delta, advance on ack,
  fail-soft), shipped via the plugin's `hooks/hooks.json` + `scripts/`.
- **Narrow write-block:** `PreToolUse` on `Write`/`Edit`/`MultiEdit`, native-memory-
  store only, teaching message, fail-open.
- **Awareness injection:** sharpen the server-sourced primer + a deterministic nudge.
- **Docs:** capability matrix (seeded), README, private-mode contract update.

**Later phases (named, not detailed here):** Pi + Hermes in-payload adapters (no
spike); OpenCode idle-bracket adapter (live-test gated); Codex (deferred pending an
upstream stable id); the dashboard auto-learn toggle; cost caps for multi-user; and
**active recall-injection** (pull relevant memory after compaction — D9 deferred the
richer version; Phase 1 ships the passive primer).

**Out of scope (this spec):**

- The **broad handoff-shaped / arbitrary-notes file veto** of the prior draft —
  explicitly dropped (ADR 0009 demotes it to the narrow native-store block).
- **Intercept-and-redirect** — auto-constructing a `store_handoff`/`remember` call
  from a blocked file write. Deferred to its own spec.
- Changing the primer's protocols, the 7-verb surface, or the memory state model.
- An adversarial control (ADR 0009 threat model).

## 4. Key decisions (locked with owner; cites carry the rationale)

1. **Capture is automatic + deterministic; recall is nudged.** The two are solved
   oppositely — saving off the agent (a hook never forgets), recall left to the
   agent's judgment but heavily nudged (ADR 0009; brainstorm D3).
2. **Incremental per-turn ingestion, not big-bang at end.** Ship the delta since a
   byte-offset cursor each turn; loses at most the last turn; needs no reliable
   end event (brainstorm D7, §8.2).
3. **Two decoupled clocks.** *Ingestion* is per-turn (durability, no LLM);
   *extraction* is once-per-conversation when settled (full context, one curator
   pass over the whole buffer). The curator never sees a lone turn (brainstorm D8).
4. **Settle = idle-timeout (primary) + explicit-end (accelerator) + size-cap
   (runaway guard).** Idle is the robust default — independent of any end event
   (brainstorm D8).
5. **Sidecar buffer, redacted, gitignored, deleted after extract.** Raw conversation
   never enters the git vault; only extracted *facts* reach the committed
   inbox→curator path (brainstorm D6, D8).
6. **Auto-captured memories flow the normal curator path with confidence bands** —
   high auto-applies, low proposes. *(Owner override of brainstorm D11's
   proposals-only.)* Bounds noise via the existing review queue without a blanket
   review burden.
7. **Default-ON**, gated by **private mode** (per-turn skip) + **`LIBRARIAN_AUTO_SAVE=false`**
   kill-switch. *(Owner override of brainstorm D2's default-off/opt-in — default-off
   perpetuates the "never used unless asked" failure this exists to fix; mitigations
   in D5/D6 make default-on privacy-defensible.)*
8. **Narrow native-store block only.** `**/.claude/**/memory/**` + its `MEMORY.md`,
   redirect to `remember`; nothing broader. Fail-open (ADR 0009 layer 3).
9. **One uniform server contract + thin per-harness adapters; Claude-first.** Build
   and dogfood Claude, then add adapters against the same contract (brainstorm §11.2).
10. **Capture hooks ship in the plugin** (`hooks/hooks.json`), not via the
    not-yet-built installer-cli.
11. **All per-session state keyed by `session_id`; all per-conversation server state
    by `conv_id` (= Claude `session_id`) — never by `$USER` or `cwd`.** This is what
    makes concurrent same-machine sessions safe (the owner runs several at once,
    often in one repo). It is exactly the corner mem0 cuts — its
    `/tmp/mem0_*_${USER}` session-id and message-count files are per-user, so two
    concurrent sessions clobber each other — and we explicitly do not copy it.
    Buffers are per-`conv_id` (not per-`cwd`), so two sessions in one repo don't
    collide; the settle-sweep claims each buffer atomically; the inbox already
    tolerates concurrent producers; SessionStart pruning is age-based, never
    clear-all. (Codex's cwd-keyed `conv_id` — brainstorm I2 — would collide here, a
    further reason it's deferred.)

## 5. Resolved decisions (were open questions; all settled with the owner 2026-06-16)

All six are resolved; the only remaining pre-build gate is the §6 live test (a
maintainer spike, not a decision).

1. **Q-extract — extractor shape. RESOLVED → bespoke extraction stage (Option A,
   owner 2026-06-16).** A new server-side LLM stage mines the settled buffer into N
   discrete candidate facts; each is `submitToInbox`'d individually and flows through
   the **unchanged** navigate→judge→apply (so the confidence bands of §4.6 apply per
   fact). The existing judge is **not** modified — Option B (teach the judge to emit
   N operations from one transcript) is rejected: `navigate` needs a concrete fact to
   search merge-candidates for, but the facts are still inside the unextracted
   transcript, forcing extraction-first anyway while enlarging the blast radius on the
   core curator that `remember` depends on. This is brainstorm §4.4 option b — the
   `/learn` extraction job moved server-side; long-term `/learn` can call the same
   extractor. Build in T2.
2. **Q-gate — the two gates. RESOLVED → couple to the one curator gate,
   server-authoritative (owner 2026-06-16).** `LIBRARIAN_AUTO_SAVE=false` is the
   per-machine client kill-switch (the hook ships nothing). The server transcript-
   intake endpoint accepts/buffers **only if the intake gate that drains it is
   enabled**; if off, it **refuses and buffers nothing** — no raw text at rest for a
   dead pipeline (resolves brainstorm I5). The gate is **`curator.intake.enabled`**
   (self-checked via `isIntakeEnabled(store)`, the same gate the intake tick reads —
   so coherence is automatic; grooming is orthogonal); the legacy
   `LIBRARIAN_CONSOLIDATOR` env now only *seeds* it. **When capture is disabled**
   (intake gate off server-side, or `LIBRARIAN_AUTO_SAVE=false`), the **SessionStart banner warns the
   agent**, naming the reason + the fix, mem0-style (see T5 / SC 9). Consequence:
   capture is only *effective* when the curator is enabled, so "curator enabled" is a
   stated precondition, surfaced in `doctor`/health and the banner. The independent
   server-side auto-learn toggle is deferred to **P-Dashboard**. Build in T2.
3. **Q-settle — defaults. RESOLVED (owner 2026-06-16).** Idle window
   `LIBRARIAN_TRANSCRIPT_IDLE_MS` = **30 min** (longer than brainstorm's 20 to avoid
   splitting a conversation across a natural pause; latency on abandoned convs is
   cheap, and cleanly-ended convs use the explicit-end accelerator). Sweep tick
   `LIBRARIAN_TRANSCRIPT_SWEEP_TICK_MS` = **5 min** (≪ idle window; aligns with the
   backup tick). Size cap `LIBRARIAN_TRANSCRIPT_MAX_BYTES` = a **generous safety
   valve**, kept — on exceed while still active, extract-and-rotate (with the Q4
   overlap) and start a fresh segment; rarely fires given the 1M-context extractor,
   but backstops total loss on a pathological session. All `LIBRARIAN_*`-configurable.
   Build in T2.
4. **Q-overlap — context carry-forward. RESOLVED → defer overlap; lean on the
   curator's merge (owner 2026-06-16).** No carry-forward in v1. Framing: a segment
   resuming after the 30-min idle gap is treated as a **new session that shares the
   previous one's context** — and that shared context lives in the **vault** (segment
   1's already-extracted facts), which segment 2's extraction reaches through the
   curator's `navigate`/recall step, not through raw-transcript overlap. Split-lesson
   risk degrades to an occasional low-confidence **proposal** (merge + confidence
   bands), never corruption. Revisit overlap (likely the cheaper *summary* flavor)
   only if dogfooding shows split-lessons in practice.
5. **Q-cursor-home — where the cursor lives. RESOLVED (owner 2026-06-16).** A local
   file in the Claude plugin data dir,
   `${CLAUDE_PLUGIN_DATA:-$HOME/.librarian/claude-plugin-data}/cursors/<session_id>`
   — idiomatic persistent plugin state, survives reboot, namespaced for uninstall.
   The cursor is **non-critical**: if lost, the hook re-ships and dedup absorbs it
   (turn-level dedup on the server buffer + fact-level dedup in the curator). Cleanup
   is **age-based** (drop cursor files older than ~7 days) — **never "clear all on
   SessionStart"** (that would clobber a concurrently-running session — see §4.11 /
   SC 15). Confirm the exact turn-dedup key in T3.
6. **Q-uncertainty-direction. RESOLVED → err toward not-capturing (owner 2026-06-16).**
   On any uncertainty the capture path skips, in two flavors: **transient/infra**
   (server unreachable, `transcript_path` unreadable) → **skip-and-retry** (don't
   advance the cursor; re-ship next turn — no data lost); **content/privacy** (can't
   establish a turn's private state, e.g. compaction dropped an `=off`) →
   **skip-and-advance** (treat as private, never ship, move the cursor forward —
   re-reading wouldn't resolve it). Capture **overrides the agent's compaction default
   of OFF** and treats ambiguous privacy as private. Never leak a stack trace into the
   model context; log skips to the sidecar. Lock in T3.

## 6. Pre-build live test (maintainer-run, gates T3)

One Claude-specific spike before the adapter is trusted (brainstorm §11.2, §11.1):

- **Claude `Stop` + `transcript_path`:** confirm the `Stop` hook fires per
  turn-end, that `transcript_path` is present and **append-only** (so a byte-offset
  cursor is valid), and capture the JSONL shape of a completed turn. If
  `transcript_path` is absent or rewritten, T3's acquisition strategy changes (fall
  back to a `UserPromptSubmit`-driven delta).

**Findings (2026-06-16 — data layer confirmed by direct inspection of a live
session** at `~/.claude/projects/<launch-cwd>/<session_id>.jsonl`):

- **Clean append-only JSONL** — every line a complete JSON object (322/322 parsed) →
  the byte-offset cursor is valid.
- **Per-turn typed entries** (`type` / `message.role` = user / assistant) with
  **monotonic `timestamp`s** — sliceable by the cursor and idle-detectable for the
  settle-sweep.
- **Stable single `sessionId`** across the file (the cursor / `conv_id` key, §4.11);
  **concurrent sessions write distinct `<session_id>.jsonl` files** — SC 15's premise
  confirmed in the wild (two live top-level files plus separate `subagents/*.jsonl`).
- **`cwd` is recorded per-entry and *changes within a session*** (a mid-session `cd`
  produced two cwds in one transcript) — real-world vindication of keying the buffer
  by `conv_id`, **not** `cwd` (§4.11): a cwd key would have split this very session.
- **Bonus fields:** `gitBranch` per entry (free branch tag for captured memories);
  the project dir is keyed by the **launch** cwd, but the hook receives
  `transcript_path` directly, so the adapter never derives the path from cwd.
- **Subagents are isolated:** subagent work is in separate `subagents/*.jsonl` files
  and main-transcript entries are `isSidechain: false` — so capturing the top-level
  `<session_id>.jsonl` gets the primary conversation **without** subagent internals
  (T3 skips subagents in v1, mirroring mem0's `agent_id` skip).

**Residual risk (small):** that the `Stop` hook *delivers* `transcript_path` to the
hook process — the data existing doesn't prove the payload carries the path. mem0's
shipping plugin consumes exactly `Stop` + `transcript_path` in Claude Code, so this is
de-risked to a confirm-on-wiring in T3, not an open design risk.

## 7. Task plan

Vertically sliced, riskiest/most-valuable first; each slice leaves the system
working and shippable. Server foundation → Claude adapter → guard → awareness → docs
→ gate.

### Phase 1 — server pipeline + Claude adapter

- [ ] **T1 — transcript-intake endpoint + uniform contract + redaction.** A new
      authed route (Bearer `LIBRARIAN_AGENT_TOKEN`) accepting the harness-agnostic
      delta payload (`conv_id`, `harness`, seq, `turns[]`, `ended?`); redacts each
      turn **on intake**; appends to the sidecar buffer. *Accept:* SC 11, SC 5
      (redaction unit), SC 6 (write path). *(Riskiest contract surface — pin it
      first.)*
- [ ] **T2 — buffer lifecycle + settle-sweep + extractor → inbox.** Sidecar buffer
      management (atomic claim, delete-after, reaper); settle detection (idle / size
      / explicit-end); **one curator pass** over the settled buffer → candidate facts
      → existing inbox → curator (confidence bands); gate coherence. *Resolves* Q-extract,
      Q-gate, Q-settle. *Accept:* SC 1 (server half), SC 3, SC 6, SC 7. *Depends:* T1.
- [ ] **T3 — Claude `Stop` acquisition adapter** (after the §6 live test). Tail the
      **top-level** `transcript_path` (`<session_id>.jsonl`) from the byte-offset
      cursor — skip `subagents/*` (entries are `isSidechain: false`) — **skip
      `[private=on]` turns**, POST the delta, advance the cursor **on ack**, fail-soft
      toward not-capturing; tag candidates with the per-entry `gitBranch` + `cwd`.
      Ship via `integrations/claude/hooks/hooks.json` + `scripts/`. *Resolves*
      Q-cursor-home, Q-uncertainty-direction. *Accept:* SC 1 (end-to-end), SC 2,
      SC 4, SC 10, SC 12, SC 15. *Depends:* T2, §6.
- [ ] **T4 — narrow write-block.** `PreToolUse` on `Write`/`Edit`/`MultiEdit`;
      block only `**/.claude/**/memory/**` + its `MEMORY.md`; teaching message names
      `remember`; **fail-open**; must-block / must-allow fixtures. *Accept:* SC 8.
      *Depends:* T3 (shares the hooks wiring).
- [ ] **T5 — awareness injection + status banner.** Sharpen the server-sourced
      primer + a deterministic `SessionStart` banner (mem0-style) that survives
      compaction. The banner queries server status and surfaces **capture state** —
      active, or a warning naming the reason (curator disabled in server settings →
      enable in the dashboard; or `LIBRARIAN_AUTO_SAVE=false` on this machine) + the
      fix. *Accept:* SC 9. *Depends:* the primer/banner shell runs parallel to T1–T4;
      wire the capture-status line after T2 (it reads the gate state).
- [ ] **T6 — capability matrix + README + private-mode contract update.** Seed the
      matrix (Claude authoritative-pending-live-test; Pi/Hermes feasible; OpenCode
      caveats; Codex blocked); document the default-on + kill-switch + private-skip
      behavior in the shared private-mode docs. *Accept:* SC 14. *Depends:* T3.
- [ ] **T7 — Phase 1 release gate.** tests / typecheck / lint green; 7-verb +
      drift-guards untouched; `.gitignore` covers the sidecar buffer; version bump +
      CHANGELOG; PR. *Accept:* SC 13. *Depends:* T1–T6.

### Later phases (separate specs/PRs)

- [ ] **P-Pi / P-Hermes** — in-payload adapters against the T1 contract (no spike;
      the §11.2 "proven floor").
- [ ] **P-OpenCode** — idle-bracket adapter (live-test gated).
- [ ] **P-Codex** — deferred pending an upstream stable conv_id; coarse per-cwd
      fallback documented, not built.
- [ ] **P-Dashboard** — admin auto-learn toggle (mirrors `curator.enabled`).
- [ ] **P-Recall** — active recall-injection after compaction (D9's deferred upgrade).
- [ ] **P-Cost** — extraction caps / cheap pre-classify for multi-user installs (D10
      scaling caveat).

## 8. Checkpoint

Phase 1 is the high-leverage, independently-shippable slice: it makes capture
automatic and awareness deterministic on the one harness the owner uses daily, on a
server contract every other harness will reuse unchanged. **T1–T7 are ready to hand
to `sdlc-implement`** once ADR 0009 is accepted on merge and the §6 live test passes;
all §5 design questions are resolved (2026-06-16), leaving that live test as the only
remaining pre-build gate.
The other harnesses, the dashboard toggle, active recall, and cost caps are named,
deferred, and gated — no integration claims capture we haven't proven the harness can
deliver.

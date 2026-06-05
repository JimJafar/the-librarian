---
title: Harness-driven capture, lifecycle hooks & awareness injection — working doc
status: 1A (auto-capture) SHELVED by owner 2026-06-05 (unsure + huge change); 1B (awareness primer) → SPEC FIRST
started: 2026-06-05
---

# Harness-driven capture, lifecycle hooks & awareness injection

> Living working doc. §1–§2 are frozen; §3+ are the iteration surface; §10 captures meta-insights.

---

## 1. The question

Can the harness drive Librarian usage at lifecycle boundaries — rather than relying on
the agent to remember to call the verbs — across three related but distinct moves:

- **(A) Harness-driven raw-text capture** — the harness deterministically + cheaply ships
  conversation text to the server for *server-side* processing, so durable lessons get
  captured **without spending the agent LLM's tokens** on reading/extracting them.
- **(B) Awareness injection** — remind the agent it *has* `remember`/`recall`/`learn`, and
  prompt it to re-ground, at **session start** and **after compaction**.
- **(C) Auto-capture at boundaries** — fire capture automatically at compaction, task
  completion, or conversation end (the agent forgets; a hook never does).

---

## 1.5 Owner's framing (Jim, 2026-06-05)

> "Using the harness to **deterministically and cheaply** send raw conversation text to the
> librarian for processing **without burdening the agent LLM**." Plus: injecting awareness of
> the librarian and the key tools `remember` & `recall` at the start of a session and after
> compaction. Pull the scattered harness-integration ideas out of TODO.md into this doc.

---

## 2. Audit — what's actually there (2026-06-05)

> Frozen evidence. file:line citations. Only update if the code changes. (Server =
> `the-librarian`; plugins = the five `the-librarian-*` repos in `~/code`.)

### 2.1 `learn` — the agent does the extraction today
There is **no server-side `learn` MCP tool** (not in `packages/mcp-server/src/mcp/tools/index.ts:26-46`).
`/learn` is a harness slash command that drives the **agent LLM**: read transcript, extract
durable facts, present a multi-select, call `propose_memory` for chosen items
(`the-librarian-claude-plugin/commands/learn.md:13-39`). The server only stores finished
proposals (`propose-memory.ts:10-13`). So **all extraction LLM work is agent-side**.

### 2.2 The consolidator inbox — server-side raw-text mining already exists (gated off)
With the consolidator enabled, `remember` is fire-and-forget: it concats title+body → `text`
→ `submitToInbox(text, hints)` (`remember.ts:40-53`). `submitToInbox` writes raw text to
`inbox/<ts>-<id>.md` + commits (`librarian-store.ts:220-224`; queue `corpus/inbox.ts:141-159`).
A server scheduler sweeps FIFO (`consolidator/sweep.ts:37-67`) → per item **navigate → judge →
apply** (`consolidate.ts:58-94`): navigate retrieves candidates from raw `submissionText`
(`navigate.ts:62-78`); judge calls the **server LLM** for create/augment/supersede/archive/noop
(`judge.ts:108-140`). **The mining engine accepts arbitrary raw text and runs fully
server-side** — but it's gated by `LIBRARIAN_CONSOLIDATOR` (default **off**,
`consolidator-config.ts:9-12`), and its **only producer is `remember`** (one note at a time).

### 2.3 Awareness-injection substrate (idea B) — server half built, client half missing
The per-turn `<conversation-state>` block is injected by each harness's UserPromptSubmit-equivalent
hook (claude: `hooks.json:3-12` → `conv-state-inject.ts:42-65`; renderer `conv-state-render.ts:26-35`,
now `conv_id` + `off_record` only). A **`session_manifest`** tool exists that returns exactly the
working-style preamble + bounded skills manifest idea (B) wants (`session-manifest.ts:22-37`, doc-comment
cites "spec 035 §F6"). **But no plugin consumes it** (zero `session_manifest` callers across the five).
Only Hermes calls `start_context` once in `system_prompt_block` (`hermes provider.py:212-217`).

### 2.4 Lifecycle hooks were BUILT then DELIBERATELY RETIRED (idea C has no live substrate)
The sessions-rethink refactor retired the whole session lifecycle. Every plugin now wires **only
per-turn conv-state injection**:
- claude: only `UserPromptSubmit` (`hooks.json:3`).
- codex: only `UserPromptSubmit`; SessionStart/PostCompact/Stop **retired** and `validate.mjs:84`
  asserts they must NOT be registered (`dispatch.mjs:7-10,25-27`).
- opencode: only `chat.system.transform`; session.created/idle/compacted **retired** (`index.ts:9-12,69-82`).
- pi: only `before_agent_start`; input/agent_end/session_compact/session_shutdown **retired** (`index.ts:3-14`).
- hermes: `sync_turn`/`on_pre_compress`/`on_session_end` are **explicit no-ops** (`provider.py:253-274`).

There is **no `@librarian/lifecycle` shared bundle**. **Zero live lifecycle-boundary hooks today.**

### 2.5 Privacy gate is now LLM-honored, not enforced
Post-rethink `/toggle-private` is "Pure in-context — no MCP call, no server flag, no plugin hook"
(`claude .../toggle-private.md:5`). On `[librarian:private=on]` the **agent** must not call
`remember`/`propose_memory` (`:7`); `/learn` needs explicit confirmation (`learn.md:9`). There's a
server `off_record` field surfaced read-only (`conv-state-render.ts:27-34`) but **enforcement is the
LLM's**. The marker survives compaction "only by luck" (`toggle-private.md:19-21`).

### 2.6 No bulk/transcript intake surface
The HTTP server exposes a single `/mcp` surface (`http.ts:250`). No `/transcript`/`/inbox`/bulk
endpoint. `submitToInbox`'s only caller is `remember` with one concatenated note — **nothing ships a
raw transcript or chunks one into the inbox**.

### 2.7 Per-harness capability audit (2026-06-05) — settings persistence, lifecycle events, transcript access

| Harness | Persistent setting | Compaction event | End/Stop event | Transcript to hook | Can check `off_record` |
|---|---|---|---|---|---|
| Claude Code | **env vars only** (`userConfig` doesn't reach hook subprocs — `CONTRIBUTING.md:18-23`) | `PostCompact` (avail, retired) | `SessionEnd`/`TaskCompleted` (avail, retired) | **unconfirmed in-repo** (Claude passes `transcript_path` JSONL, just not exercised here) | yes (`conv_state_get`) |
| Codex | env vars + `config.toml` (not plugin-read) | `PostCompact` | `Stop` per-turn; **no SessionEnd** (real gap) | **unconfirmed/partial** (spec hints last-message only) | yes |
| Hermes | **JSON config file** (`librarian-plugin/config.json`, `provider.py:97-140`) | `on_pre_compress(messages)` | `on_session_end(messages)`+`sync_turn` | **yes — messages passed directly** (`provider.py:253-274`) | yes (`provider.py:239`) |
| OpenCode | env vars + plugin-data dir | `session.compacting`/`compacted`/`messages.transform` | `session.idle` | **yes** (`messages.transform` / `client.session.messages()`) | yes (`system-transform.ts:45`) |
| Pi | env vars only (`config.ts:31-44`) | `session_before_compact`/`session_compact` | `agent_end`/`turn_end`/`session_shutdown` | **yes** (`event.messages`, `AgentSession.messages`) | yes (`system-prompt-augment.ts:45`) |

Two key facts for the toggle's home:
- **Server-side admin setting has a proven in-tree pattern: `curator.enabled`.** Stored in `SettingsStore`
  (`curator-config.ts:28,114,179`), admin-only tRPC (`trpc/curator.ts:25-37`), dashboard `/curator` page, and
  the **server worker gates on it before acting** (`curator-tick.ts:43`, `consolidator-tick.ts:37`). The
  consolidator ingest is *also* env-gated by `LIBRARIAN_CONSOLIDATOR` (`consolidator-config.ts:9-12`). So an
  admin-controlled "process / drop auto-learn submissions" setting that the ingest path consults is a
  copy of an existing, working pattern — and it's the **only** mechanism that drops submissions centrally
  regardless of which harness sent them.
- **All five hooks already call `conv_state_get`** → a capture hook can read `off_record` and refuse to ship a
  private conversation, with **no agent involvement** (`conv-state-get.ts:24-26` serializes the full row).

Capability bottom line: **Hermes / OpenCode / Pi support fully-deterministic (no-agent) transcript capture
today.** Claude is very likely fine (`transcript_path`) but unproven in-repo. **Codex is the weak link** (no
session-end event; transcript payload may be last-message-only) → degraded or agent-mediated there.

### 2.x Bottom line from the audit
- **Idea (A) is ~70% built but mis-plumbed.** The server-side mining engine (inbox + navigate→judge→apply
  + server LLM + confidence bands) is real; the **gap is intake** — there's no surface that takes a raw
  transcript and no harness path that ships one. (A) = "add a bulk/transcript producer in front of the
  existing consolidator," NOT "build extraction."
- **The agent-LLM burden today sits entirely at extraction/decision** (`/learn`, choosing what to
  `remember`). The consolidator already removes the *filing/merge* burden, not the *reading-the-transcript* one.
- **Idea (B)'s server half exists (`session_manifest`), client half doesn't.** "After compaction" has **no
  signal** in any plugin.
- **Idea (C) means reversing a deliberate decision** — lifecycle hooks were built and removed. Understand *why* first.
- **Privacy:** any auto-capture runs outside the agent's awareness → outside the `[private=on]` marker; it'd
  have to consult server `off_record` directly, which the marker model doesn't keep authoritative.

---

## 3. Reframing

The audit collapses three "build it" ideas into one "re-plumb + decide policy" question:

1. The **engine** for (A) exists (the consolidator). The work is a **transcript intake** + a **harness
   producer**, plus the policy around cost and privacy of shipping raw text.
2. (B) is a **separable, cheaper, lower-risk** win: wire the already-built `session_manifest` into a
   start-of-session + post-compaction injection. It nudges the agent; it doesn't touch the privacy/cost risk.
3. (C) is **not greenfield** — it's "should we re-introduce lifecycle hooks that were deliberately retired,
   now repurposed for capture rather than session management?" That's a decision, not a build, and §4.1 gates it.

So the real question isn't "can we?" (mostly yes, cheaply) but **"what's the right policy for shipping raw
conversation text server-side — on cost, precision, and privacy — and which lifecycle signals justify it?"**

### 3.1 Trigger-point mapping (the moments sort by direction)
The two directions have *different* natural triggers — and **SessionStart serves neither capture nor recall**
(nothing to capture yet; no query to recall against). It earns its keep for **setup** instead (§3.2).

| Direction | Purpose | Natural trigger(s) |
|---|---|---|
| **Outbound** (recall / awareness — *ground the agent*) | inject relevant memory | **first meaningful turn** (a query exists) · **post-compaction** (context lost, query exists) |
| **Inbound** (capture — *save what happened*) | ship transcript → consolidator | **pre-compaction** (save before loss) · **Stop / end / task-done** (save the whole thing) |

Symmetry: **compaction is the pivotal boundary for both** — `PreCompact` = capture-before-loss; `PostCompact`
= recall-to-restore. (Matches the old TODO note calling PostCompact "the highest-value hook.")

### 3.2 The first-turn injection does *setup*, not capture (Jim, 2026-06-05; see D1)
*Considered dropping SessionStart entirely; revised — but the work rides the **first meaningful turn** (the
existing per-turn channel), not a resurrected SessionStart hook. Two setup jobs:*
1. **Brief awareness primer.** Inject a short "you have The Librarian — durable memory; use `recall`/`remember`"
   note. Rationale: **we can't rely on the agent auto-loading the skill/plugin**, so without a deterministic
   primer the agent may never realise the Librarian exists. Keep it brief (context budget); it's a reliability
   floor, not a replacement for the skill.
2. **Auto-learn consent gate.** Ask the user once per conversation: *"Enable auto-learning for this
   conversation?"* → if yes, the inbound transcript capture (idea A) is armed; if no, nothing is shipped. This
   makes auto-capture **explicitly opt-in** — which is the privacy story (see §4.3).

---

## 4. Open questions

### 4.1 Why were the lifecycle hooks retired? — **RESOLVED (Jim, 2026-06-05)**
They were coupled to the now-redundant **session** model (auto-start/checkpoint/pause/end a Librarian
*session*). The **purpose** died, not the **mechanism**. → Re-using lifecycle hooks for capture/awareness is a
**clean new purpose, not a reversal**. Idea (C) is on the table.

### 4.2 "Cheaply" — cheap for whom? — **RESOLVED:** cheap on the agent's critical path (zero tokens, fire-and-forget delta); server pays the extraction async + batched (D7/D8).
"Deterministically and cheaply send raw text without burdening the agent LLM" bundles two cost models:
- **The send** is genuinely cheap + deterministic: a hook POSTs raw text → **zero agent tokens**, fires every
  time (the agent can't forget).
- **The processing** is the existing consolidator — an **LLM** call per item, **not** cheap and **not**
  deterministic; it just moves **off the agent's turn** onto the **server's async budget**.

Is the intent "cheap *for the agent's critical path*, paid for by the server async" (almost certainly yes)? If
so, the design owns a new **server-side LLM cost** that scales with transcript volume — see §4.4.

### 4.3 Privacy — raw text leaves the agent's judgment — **RESOLVED:** dashboard arming (D2) + per-turn `off_record` skip (D7) + secret-redaction on intake (D6).
Today the off-record gate is the **agent** declining to call `remember` when it sees `[private=on]`. A
deterministic harness capture path **bypasses the agent entirely** — it would ship private text to the server
unless gated. **The opt-in consent gate (§3.2) is the primary answer:** auto-capture is default-OFF and only
arms on explicit per-conversation consent, so the harness never ships transcripts the user didn't agree to.
Residual sub-questions: (a) within an opted-in conversation, can the user still go off-record mid-stream
(`[private=on]`) and have the *hook* respect it (it must check `off_record`, not the agent)? (b) raw transcript
still moves **redaction** (secrets/credentials) to "the server must scrub what it was handed" — so server-side
redaction-on-intake is still needed even with consent.

### 4.4 The granularity mismatch — a raw transcript isn't a "submission" — **RESOLVED by D4 (option b, no pre-filter)**
The consolidator's navigate→judge→apply judges **one submission at a time** — it decides a single
create/augment/supersede/archive/noop against one candidate fact (`judge.ts:108-140`). A 50-turn raw transcript
is **not one fact**, so feeding it in as a single `submissionText` judges at the wrong granularity. So the
producer has to do one of:
- **(a) Dumb chunk** the transcript into many inbox items (per-turn / per-N-tokens). Cheap to produce, but each
  chunk gets its own navigate→judge LLM pass (**many server-LLM calls**) and a chunk often isn't a clean fact →
  noisy, low precision.
- **(b) Server-side extraction stage** — a new component that mines the transcript into **discrete candidate
  facts** *before* the inbox. This is exactly the `/learn` extraction job **moved from the agent to the
  server** (the audit confirmed no server-side extractor exists today, §2.1). It's an **LLM pass over the
  transcript** — *cheap for the agent (zero tokens), a real cost for the server*, run async off the turn.
- **(c) Pre-filter at the hook** — only ship on "substantial work" signals (files changed, length threshold),
  to bound how often (b) runs.

So idea (A)'s actual new build is **(b): a server-side transcript→candidates extractor in front of the existing
consolidator**, optionally gated by **(c)**. Open: is (b) a bespoke stage, or can the consolidator's
navigate/judge be adapted to "given this transcript, propose N candidate facts"? And where does (c)'s
"substantial" line sit — hook-side heuristic vs. server-side cheap classifier? This is where the server-LLM
cost lives.

### 4.5 Which lifecycle signals are worth wiring, per harness? — **RESOLVED:** capture = the per-turn hook (D7), not boundary events; `PostCompact` (where available) serves the separate recall/awareness direction (B).
Claude Code has the richest set (`SessionStart`, `UserPromptSubmit`, `PreCompact`, `PostCompact`, `Stop`,
`SessionEnd`). Map each idea to a signal: setup → `SessionStart` (§3.2); awareness/recall → first
`UserPromptSubmit` + `PostCompact`; capture → `PreCompact` + `Stop`/`SessionEnd`. Which harnesses even have
compaction / end signals (per §2.4 most were retired; Hermes/opencode/pi differ)? Do we wire the
lowest-common-denominator, or per-harness best-effort?

### 4.6 Can a SessionStart hook actually *ask* the user a question? — **MOOT (D2: no question; dashboard toggle)**
The consent gate (§3.2) assumes the harness can surface a yes/no at session start. But Claude Code SessionStart
hooks return *injected context*, they don't run interactive prompts. So the real mechanism is probably one of:
(a) the hook **injects an instruction** telling the agent to ask on its first turn (costs a turn + relies on the
agent to comply); (b) a **harness-native prompt** if the harness supports it (varies per harness); (c) a
**remembered preference** (ask once ever / per-project, store the answer) so it isn't asked every conversation.
Empirical per-harness question — audit before committing.

### 4.7 Consent granularity + default — **MOOT (D2: dashboard on/off + `off_record` per-conversation opt-out)**
Per-conversation consent matches "this conversation" but adds friction (asked every time → annoying → users
reflexively say no → low capture rate). Alternatives: a remembered **per-project** or **global** default with
an easy per-conversation override; or **default-on with a visible off-switch** (higher capture, weaker
consent). What's the default, and at what scope is consent remembered?

---

## 5. Working hypotheses

> Tentative — refined/discarded as we go.

- **H1 (idea A):** Add a thin **transcript-intake** path (a "submit raw text for consolidation" surface that
  chunks → inbox), and a harness producer (a `PreCompact`/`Stop` hook) that ships the recent transcript. Reuses
  the existing consolidator as-is. Owns a new server-LLM cost (§4.4) + a privacy gate move (§4.3).
- **H2 (idea B, separable):** Brief awareness primer at `SessionStart` (reliability floor for unreliable skill
  auto-load) + a recall-grounding on the first turn / after `PostCompact`. Pure nudge, zero capture risk,
  cheapest win — likely worth doing first/independently.
- **H3 (idea C):** Re-introduce lifecycle hooks *repurposed for capture/awareness* (not session management).
  *(§4.1 resolved — mechanism is fine; (C) is a clean new purpose.)*
- **H4 (consent-gated capture)** *(consent-question mechanism superseded by D2; intent survives):* the
  default-off + explicitly-controlled intent is kept, but delivered via the **dashboard toggle + `off_record`
  self-gate** (D2), not a per-conversation question. §4.6/§4.7 are moot under D2.

---

## 6. Decisions

**D1 (2026-06-05)** — **Setup rides the first meaningful turn, not a SessionStart hook.** The two setup jobs —
(1) a brief deterministic awareness primer (reliability floor, since the skill/plugin may not auto-load) and
(2) arming the auto-learn capture — are injected on the **first turn** via the per-turn `UserPromptSubmit`-style
channel that already exists in all five plugins. Capture and recall-grounding happen at later boundaries
(turn / compaction / end). *Rationale:* a `SessionStart` hook can't run interactive prompts and is the least
uniform event across harnesses; the per-turn injection channel works everywhere and is already wired.

**D3 (2026-06-05)** — **North star: take ~everything off the agent. The hook is dumb + deterministic; all
intelligence is server-side.** The capture hook ships the transcript when (armed **and** not `off_record`) with
**no agent judgment and no unreliable hook-side heuristics** — conversation **length is explicitly rejected** as
a "worth learning" signal. Deciding *what's worth keeping* (and controlling its cost) happens **server-side**.
*Rationale (the motivation for the whole feature):* agent-side capture is (a) **disruptive** — it interrupts and
slows the user's conversation pace — and (b) **unreliable** — agents forget it or apply it inconsistently. Every
design choice should push work off the agent toward the deterministic hook + the server.

**D2 (2026-06-05)** — **Auto-learn is a server-side admin (dashboard) toggle; the plugin gates the wire on it.**
The on/off lives as a server setting in `SettingsStore`, edited from the dashboard, mirroring the existing
`curator.enabled` pattern (admin tRPC + worker-gates-before-acting). The **first-turn setup call returns the
armed/disarmed flag** to the plugin (alongside the awareness primer + manifest — same round-trip), so when
auto-learn is **off the plugin sends nothing over the wire** (not shipped-then-dropped). The capture hook ships
the transcript at compaction/end **only if** (armed) **and** (`off_record` false) — both read from the server,
**no agent in the loop**. The server keeps an authoritative drop as a backstop. Per-conversation opt-out is the
existing "this is private" marker; **no consent question**. Best-effort per harness (Hermes/OpenCode/Pi support
it today; Claude pending `transcript_path` confirmation; Codex degraded — last-message-only, no session-end).
*Implementation note:* hooks are separate subprocesses (§2.7), so the armed flag must reach the capture hook via
the per-session local state file the conv-state hook already uses, **or** the capture hook re-reads it from the
server when it fires (simplest, freshest). *Supersedes the SessionStart/first-turn **consent-question**
mechanism* — the consent *intent* (default-off, owner-controlled, per-conversation opt-out) survives; the
mechanism is now a dashboard toggle + the `off_record` self-gate, which removes the agent-participation and
per-conversation-friction problems entirely.

**D4 (2026-06-05)** — **Keep extraction simple: one curator-LLM pass, no pre-filter.** The server-side extractor
is a single curator-LLM pass over the transcript → candidate facts → the existing consolidator inbox
(navigate→judge→file). **No semantic/novelty pre-filter** — *rejected* (Jim): we *want* similar/related material
to reach the judge so it can `augment`/`supersede` into richer documents, so a similarity gate would discard the
highest-value updates; and it's premature optimisation with no baseline. Cost optimisation is **deferred** (the
§8.1 menu is parked, not chosen). *Rationale:* don't optimise before there's a working baseline; the obvious
filter fights the merge purpose.

**D5 (2026-06-05; ⚠ blind review M1: the "Claude is capture-capable" claim is ASSUMED, not confirmed — needs a spike)** — **The transcript is opaque, best-effort text; never hard-parse it in the hook.** Harnesses
expose a transcript "for convenience" with **no format-stability guarantee** (Claude Code's `transcript_path`
JSONL may change shape over time). So the hook ships it **raw**, and the **server LLM extractor reads whatever
arrives** (robust to format drift in a way a parser isn't) — which is just D3 again. Fail soft if a transcript
can't be read (house rule: never break the user's turn). This confirms **Claude Code is capture-capable**
(`transcript_path`), resolving §2.7's "unconfirmed". *(The Codex "no session-end" gap noted here is later
**fixed** by D7 — incremental per-turn capture doesn't need an end event; Codex's per-turn `Stop` is the delta.)*

**D6 (2026-06-05, confirmed)** — **Redaction on intake.** Secret-redaction runs on each delta *before* it is
written to the transcript buffer (reuse the consolidator's redaction, moved earlier). Non-negotiable — secrets
must never reach git history (or even the sidecar buffer in the clear).

**D7 (2026-06-05, confirmed)** — **Capture is incremental per-turn, not big-bang at end.** Driven by the
reliable per-turn hook (already wired in all five plugins); ships the delta since a per-conversation **cursor**
(in conv-state); **skips `off_record` turns** (per-turn privacy skip — resolves §4.8 B & C); accumulates into a
server-side buffer; **extraction is decoupled** and runs when the conversation settles (D8). Survives
app-close / `/clear` / abandon (loses at most the last un-ingested turn). *Supersedes the PreCompact/Stop/end
**capture** triggers; PostCompact still serves the separate recall/awareness direction. Also upgrades Codex
(per-turn `Stop` = the delta; no end event needed).*

**D9 (2026-06-05, resolves C2)** — **Awareness = a passive primer; active recall-injection deferred.** Idea B
(the owner's co-equal goal §1.5) is, for now, a **brief passive primer** ("you have The Librarian —
`recall`/`remember`/`learn`"); **not** active recall-injection (that richer "(b-ii) pull relevant memory and
inject it after compaction" is deferred). **Mechanism:** the primer **rides the existing per-turn conv-state
injection** — the block already fires every turn in all five plugins and already survives compaction by
re-injecting each turn — so it needs **no new post-compaction hook** and **genuinely reuses the uniform channel**
(contrast capture, which needs per-harness adapters, §11.2). Primer text is **server-sourced** (updatable without
re-releasing plugins); the richer F6 `session_manifest` preamble is a deferrable upgrade. *Rationale:* a passive
primer is the reliability floor the owner asked for (agents may not auto-load the skill); riding the per-turn
block makes compaction-survival free. *(Supersedes D1's "first-turn-only" framing of the primer — it's now
every-turn via the existing block, which is strictly simpler and covers post-compaction for free.)*

**D10 (2026-06-05, resolves C3 — cost)** — **Accept the extraction cost for now; no explicit cap.** The owner
judged it tolerable: auto-learn only assesses **text** (no tool execution), the install is effectively
**single-user**, and it's already **default-off + opt-in** (D2) and **per-conversation batched** (D8) — so the
spend is modest. No per-install cap/rate-limit for the baseline; the smart optimisations (cheap/local model,
§8.1) stay deferred. **Known caveat (deferred):** a busy *multi-user* install might want a cap — documented as a
scaling consideration, not built now. *(This is now an explicit decision, not the "deferred-then-stamped" the
review flagged.)*

**D11 (2026-06-05, resolves C3 — quality + review M3)** — **Auto-captured memories land as PROPOSALS, not
auto-active.** Every auto-learn extraction routes to the proposal queue (`requires_approval`) regardless of the
judge's confidence — overriding the consolidator's default auto-apply **for this lane** — so the owner reviews
them on the existing dashboard `/proposals` page. This bounds the extractor-hallucination/noise risk (M3) and
gives the owner a visible backstop, while keeping the **agent** out of the loop (D3 intact — the burden is
*owner* curation, async + batched, never in-conversation). Trade-off: an owner-review queue (acceptable; reuses
the existing proposal flow).

**D8 (2026-06-05)** — **The buffer + "settled" rule.** Each conversation accumulates into a per-conversation
buffer **`transcripts/<conv_id>.md`** (deltas appended; secrets redacted on write per D6). A curator pass every
~10 min treats any buffer **idle for ~20 min as complete** → extracts it → **deletes** it; a later delta with
the same `conv_id` after deletion (the always-on `/clear` remote scenario) starts a fresh buffer = a new
conversation. **The buffer is a SIDECAR (outside the git vault), not committed** — it's high-churn raw
conversation; committing it would bloat git history and persist conversation content there permanently.
Delete-after-extract leaves zero trace; only extracted *facts* reach the committed inbox→consolidator→memory
path. **Ingest atomically claims the buffer** (rename to `.processing`) before extracting, so a straggler delta
starts a fresh buffer rather than racing the delete. *(Thresholds tunable; a pause longer than the idle window
splits a conversation into two buffers — the consolidator reconciles. Whether `conv_id` survives `/clear` is
harness-specific; if it changes, the reuse case is automatic.)*

---

## 7. Loose ends / parking lot

**Pulled from `docs/TODO.md` "Harness integration ideas" (2026-06-05) — superseded framing noted:**

- **Auto-manage via Claude Code lifecycle hooks** *(original framing was session-centric; sessions are now
  retired — reframe onto remember/recall/learn per this doc):*
  - `SessionEnd` → auto-pause (session model — **retired**; reframe = capture-then-stop?).
  - `PostCompact` → auto-checkpoint with the rolling summary ("highest-value hook — compaction is where
    [context] is most at risk"). **Reframe:** `PreCompact`/`PostCompact` → capture + re-inject awareness.
  - `TaskCompleted` → finer-grained capture; "risk of a noisy ledger; gate on 'task touched ≥ N files'."
  - Open Qs (still live): how to thread session/conv id into the hook process (env var vs side-channel file —
    cf. audit note that hooks can't reliably export env into the parent); whether other harnesses have analogous
    lifecycle events.
- **Per-harness command registration** (tangential to capture; parked here for completeness):
  - Hermes per-verb commands — pending whether Hermes supports per-command registration w/ autocomplete.
  - Codex slash surface (shelved) — no user-invokable slash primitive; options: priming skill / `UserPromptSubmit`
    intercept / wait for native commands.
  - Pi runtime (shelved) — revisit once Pi's interface is defined.
- **Stale operator chore (TODO.md §Operator):** "Exercise the remaining `/lib-session-*` verbs end-to-end" —
  references retired sessions; should be deleted, not done.

---

## 8. Sub-question deep-dives

### 8.1 Making server-side extraction quick + cheap — **PARKED (D4: simple baseline first)**
Per D4 we ship the simple one-pass extractor first and optimise only if a real cost problem appears. Deferred
options, for later:
- **Semantic novelty pre-filter — *REJECTED* (D4):** would gate on dissimilarity-to-known, but we *want* similar
  material to reach the judge (that's how `augment`/`supersede` enrich existing docs); it would drop the
  highest-value updates. Do not build.
- **Cheap/local model for the extraction pass** (cf. the bundled embedder; the old TODO's "tiny local LLM").
- **Incremental / delta** — mine only the transcript since the last capture, not the whole thing each time.
- **Two-tier** — cheap extractor → the existing navigate→judge for dedup/merge/file.
All of the above are **deferred tuning**, revisited only with a baseline + real cost data.

---

## 9. Sanity-check: end-to-end scenarios (2026-06-05)

### A — User corrects a known fact mid-conversation ✓
"Actually X is Y now." Capture ships the transcript → extractor emits "X is Y" → judge matches the existing "X
is Z" memory → `supersede`/`augment`. **Verdict:** works *because* D4 kept the novelty filter out — the
correction reaches the judge. This is the case that justified D4.

### B — User goes `[private=on]` at turn 10 of 20, stays private ⚠
Capture fires at end; hook reads `off_record` = **ON** → ships **nothing**, losing turns 1–9 (which were public
and possibly valuable). **Verdict:** safe but lossy — fire-time off_record over-suppresses.

### C — User goes private at turn 10, back on record at turn 18 ✗ **(privacy leak)**
Capture fires at end; hook reads `off_record` = **OFF** (they're back on record) → ships the **whole
transcript, including the private turns 10–17**. **Verdict:** a real leak. **Fire-time off_record is the wrong
model for a multi-turn transcript** — see §4.8.

### D — Conversation full of secrets/credentials ✗ **(secrets in vault)**
Raw transcript ships → `submitToInbox` writes it to `inbox/<ts>.md` → **committed to the git vault**. The
consolidator redacts at *evidence* time, but the **raw inbox file is written + committed first** → unredacted
secrets land in git history. **Verdict:** must **redact on intake**, before the inbox file is written. See §4.9.

### E — Codex conversation that ends without compaction ⚠
Codex has no session-end event and only per-turn `Stop`/`PostCompact`. A short Codex chat that never compacts
never hits a capture boundary → never captured. **Verdict:** degraded/best-effort on Codex, as D5 noted.

### F — "Thanks, bye" trivial conversation ⚠
Ships + mined (no length gate, D3); extractor/judge discard-bias noops it. **Verdict:** correct outcome, at the
cost of a wasted extraction pass — the cost we consciously deferred (D4).

### G — Admin toggles auto-learn OFF mid-conversation ✓
Capture hook re-reads the flag at fire time (D2) → sees OFF → ships nothing; server's authoritative gate is the
backstop either way. **Verdict:** clean.

### H — Compaction, then more work, then end ⚠
Whole-transcript capture at `PreCompact` *and* at end re-mines turns 1–N twice; judge is idempotent-ish
(noop/augment dupes) but it's wasted cost. **Verdict:** works; the parked **incremental/delta** optimisation
(§8.1) would fix the redundancy.

### I — Two harnesses (Claude + Codex) in one cwd ✓
Both ship; two candidate sets → consolidator dedups/merges. **Verdict:** fine — dedup is the consolidator's job.

### J — Server unreachable when the capture hook fires ✓
Fail-soft (D5 / house rule): the hook swallows the error, never breaks the user's turn; the transcript is just
not captured. **Verdict:** acceptable (best-effort capture, never blocks).

### Findings summary *(updated after the §8.2 incremental reframe + D6–D8)*
- **Clean:** A, G, I, J.
- **Resolved by the incremental model (D7/D8):** **B & C** — privacy is a per-turn skip; no retroactive leak,
  no loss of earlier public turns. **E** — Codex no longer needs an end event (per-turn `Stop` = the delta).
  **H** — incremental delta means no re-mining.
- **Resolved by D6:** **D** — secret-redaction on intake, before anything is written.
- **Works with notes:** **F** — a "thanks bye" conversation still costs one (batched, server-side) extraction
  pass; the cost we consciously deferred (D4). No remaining ✗.

---

## 8.2 (Jim's reframe) — INCREMENTAL ingestion off the per-turn hook, not big-bang at end
**Problem with end-of-session triggers:** there's no reliable one — users close the app, end the chat, or
`/clear` a long-running remote session. Building capture on an end event loses those conversations entirely.

**The reframe:** drive capture from the **per-turn hook** (the `UserPromptSubmit`-equivalent that *already fires
every turn in all five plugins*), ingesting only the **delta since the last ingestion point**. Mechanism:

1. **Cursor** (per conversation) records "ingested up to here," stored in **conv-state** (the hook already
   reads/writes conv-state, keyed by `conv_id`).
2. **Each turn**, the per-turn hook ships the **just-completed turn(s) since the cursor**, then advances the
   cursor. Forward-only.
3. **Privacy becomes a trivial per-turn skip:** if `off_record` was on for a turn, **don't ship that turn** —
   no span-parsing needed (the per-turn granularity *is* the privacy granularity). Because the cursor only moves
   forward, a private turn is **never retroactively shipped** when off_record later flips back. This resolves
   §4.8 Scenarios B **and** C outright, and is simpler than the strip-spans options.
4. **Reliability:** since we've been ingesting all along, an app-close / `/clear` / abandon loses **at most the
   last un-ingested turn**, not the conversation.
5. **Cost — the key decoupling:** *ingestion* (ship a small delta, fire-and-forget) is cheap and happens every
   turn; **extraction is DECOUPLED** — the server mines a conversation's accumulated buffer **only when it
   settles** (idle timeout / turn threshold / the existing consolidator sweep), not per turn. So per-turn
   overhead ≈ one extra cheap POST; the expensive LLM extraction is batched server-side.

**Reuses:** the per-turn hooks (wired), conv-state (read/written already), the inbox + consolidator sweep
(exists). **New bits:** a cursor field in conv-state; delta-slicing in the per-turn hook; a **per-conversation
accumulating buffer** server-side (different shape from today's one-shot `remember` inbox items); a
"conversation settled → extract" trigger.

**Open / feasibility:**
- **Per-turn transcript access varies:** Hermes `sync_turn(user, assistant)` hands the turn directly; Claude
  reads `transcript_path` and slices since the cursor; OpenCode/Pi get `messages`. Codex `Stop` fires per turn
  but its payload may be last-message-only — slicing-since-cursor needs confirming there.
- **Timing:** `UserPromptSubmit` fires *before* the assistant replies, so it ingests "up to the previous
  completed turn" (always one turn behind — fine).
- **The "settled" trigger:** ~~tuning~~ → **decided (D8):** per-conversation sidecar buffer, ~10-min curator
  pass, ~20-min-idle = complete → extract → delete; same-`conv_id`-after-delete = new conversation.
- **Buffer + cursor crash-safety:** double-shipped turns are deduped by the consolidator; a lost cursor just
  re-ships (idempotent).

*This supersedes the PreCompact/Stop/end **capture** triggers (§3.1) — capture is now per-turn incremental;
those boundaries are unnecessary for capture. `PostCompact` still serves the separate recall/awareness direction.*

## 4.8 (raised by Scenario C) — privacy is per-*turn*, capture is per-*transcript* — **RESOLVED by §8.2 (per-turn skip)**
`off_record` is a point-in-time flag (most-recent-marker-wins), but capture ships a multi-turn span whose
privacy state can change within it. A single fire-time check **leaks** (private-then-public, Scenario C) or
**over-suppresses** (public-then-private, Scenario B). Options: **(a)** per-turn privacy tagging — exclude turns
that were `off_record` *when they occurred* (precise; needs per-turn privacy state to travel with the
transcript); **(b)** "**ever** off_record in this conversation → never capture it" (simple, conservative, safe,
but loses whole conversations for one private turn); **(c)** **incremental capture** — ship the delta since last
capture, gated by the off_record state *of that delta* (aligns timing with privacy; needs segment-level capture).

## 4.9 (raised by Scenario D) — redaction must happen on intake, before the vault write
The capture path must run the existing secret-redaction **before** `submitToInbox` writes/commits the inbox
file — otherwise raw secrets enter git history. Reuses the consolidator's redaction, but moves it earlier in the
pipeline (intake, not evidence-gathering). Likely a hard requirement, not an option.

---

## 10. Late-stage observations

### 10.1 The design is additive — but `/learn`'s role narrows
This design adds a server-side capture lane and reuses the existing consolidator wholesale; it deletes almost no
legacy. The one thing whose role *shrinks*: the agent-driven **`/learn`** command. With auto-learn on, the
server captures continuously, so `/learn` is no longer the primary capture path — it becomes a **manual
fallback** ("save what we just figured out, now") for when auto-learn is off, or for an explicit on-demand
flush. Worth keeping (it's the user-initiated escape hatch), but the docs/skill should stop presenting it as
*the* way lessons get saved. Not a deletion — a demotion.

### 10.2 The whole design rides existing rails *(⚠ overturned by blind review §11/C1 — see below)*
Almost every piece is a small addition to something already built: the per-turn hook (wired), conv-state (the
cursor's home), the consolidator inbox + sweep (the extraction engine), the `curator.enabled` settings pattern
(the toggle), the secret-redaction (moved earlier). *The blind review found this **overstated**: the wired
per-turn hooks do **not** deliver the turn delta in 4/5 harnesses (C1), and the consolidator is **env**-gated not
`curator.enabled`-gated (I5). The genuinely new + unproven work is larger than "~70% pre-built" implied.*

---

## 11. Blind review (2026-06-05) — NOT spec-ready; three Criticals reopen the design

An independent **cold, adversarial** review (no conversation context; codebase access; briefed to attack, not
bless) found the audit (§2) largely accurate but three **Critical** holes that block spec-readiness.

**C1 — [RESOLVED with per-harness adaptation — see §11.2] The per-turn *delta* D7/D8 depend on is NOT available in the wired hooks (4 of 5 harnesses).** The wired
per-turn hooks deliver the incoming **prompt / system-prompt**, not the just-completed **turn delta**: Claude
reads only `session_id` (`conv-state-inject.ts:106`) — getting the delta needs `transcript_path` (never
exercised in-repo) and `UserPromptSubmit` fires *before* the assistant replies; Codex carries only `prompt`, has
**no** `Stop` handler (`dispatch.mjs:25-27`, forbidden by `validate.mjs:84`); OpenCode `chat.system.transform`
gets `{sessionID}` only; Pi `before_agent_start` uses `systemPrompt` (`messages` assumed). **Only Hermes** hands
turn content (`sync_turn`) — and that's a *different method* from the conv-state channel. So D1/D7's "rides the
existing per-turn injection channel" is **wrong**; delta-slicing is new, per-harness, unproven work. → **Reopens
D7/D8. Needs a real per-harness feasibility spike before either is a decision.**

**C2 — [RESOLVED by D9: passive primer riding the per-turn block; active recall-injection deferred] Idea (B), a co-equal owner goal (§1.5), was never designed — only stamped.** Awareness of
`remember`/`recall` at session-start + **after compaction** got one clause in D1; "after compaction" has **no
live signal in any harness** (all compaction hooks retired; no decision reinstates one — the very reversal §4.1
justifies, but only for capture), and `session_manifest` has **zero callers**. (a) got D2–D8 + 10 scenarios;
(b) got "MOOT/RESOLVED" stamps that resolve by deferral. → **Reopens idea B as its own design track.**

**C3 — [RESOLVED by D10 (accept cost, single-user/text-only) + D11 (auto-captured → proposals)] Cost is unbounded by an explicit decision.** D4 deferred cost on an **O(items)** engine that
re-embeds + judges **per item** (`librarian-store.ts:226-231`), and every trivial conversation pays (D3 rejected
length gates). Legitimate for a prototype, but a **Critical open item for a spec**, presented as settled. →
**D4's "deferred" must become an explicit bounded-cost policy** (per-install cap, batching, cheap pre-classify,
or "manual `/learn` only at scale").

**Important:** **I1** D3 "dumb hook" contradicts D7's stateful slicing + D5's "never parse" (slicing *is*
parsing) — resolve it. **I2** `conv_id` is **cwd-keyed on Codex** (no stable id) → two Codex convs in one cwd
collide into one cursor+buffer. **I3** the 20-min "settled" rule **splits the owner's own** long-running-remote
usage into disjoint buffers (never scenario-walked); "the consolidator reconciles" is hand-waved (it judges
fact-by-fact, no cross-buffer context). **I4** the sidecar buffer is redacted-but-real conversation **at rest
~30 min**, and redaction is a **known-format regex** that misses exotic secrets (worse on high-volume
transcripts than on a hand-written `remember`). **I5** D2 mirrors `curator.enabled` but the consolidator is
**env-gated** → new work + a two-gate confusion (auto-learn ON in dashboard while consolidator OFF in env →
buffering into an unswept inbox).

**Minor:** **M1** D5 laundered an assumption into "confirmed" (now marked ASSUMED). **M2** crash mid-buffer /
orphaned `.processing` has no reaper (the inbox has one; the new buffer doesn't). **M3** extractor hallucination
→ auto-created noise (the judge auto-applies `create` regardless of confidence, `judge.ts:125`). **M4**
default-off + demoted `/learn` (§10.1) + un-wired awareness (C2) = **a capture *and* awareness gap in the common
(default) case.**

### 11.1 Resolution status (all three Criticals closed)
1. **C1** — ✅ resolved (§11.2): per-harness acquisition adapter → uniform server contract; Pi+Hermes proven,
   Claude+OpenCode feasible-pending-live-test, Codex a known limitation (no stable id).
2. **C2** — ✅ resolved (D9): passive primer riding the per-turn block; active recall deferred.
3. **C3** — ✅ resolved (D10 accept-cost + D11 auto-captured→proposals).
4. **Importants:** **I1** ✅ (D3 reworded: mechanical adapter, no judgment). **I2** ✅ owned (Codex limitation,
   §11.2). **I3** (20-min split of long sessions) **accepted** — lower-stakes now that captures are proposals
   (D11) + consolidator dedups; threshold tunable. **I4** (buffer-at-rest ~30 min redacted; regex redaction
   imperfect) **accepted residual** for the single-user/self-hosted baseline — the buffer is on the owner's own
   box, transient, redacted; the regex-redaction gap is pre-existing, flagged not fixed here. **I5** (the
   dashboard auto-learn toggle vs the env `LIBRARIAN_CONSOLIDATOR` gate) — **spec must define their
   interaction** so auto-learn can't buffer into an inbox nothing sweeps. **M2** (orphaned `.processing` buffer
   needs a reaper) — spec/build detail.

### Pre-spec / pre-build gates (carry into the spec)
- **3 live tests** (§11.2): Claude `Stop`+`transcript_path`; Codex `Stop` payload + any stable id; OpenCode
  `session.idle` bracketing.
- **I5** two-gate interaction; **M2** buffer reaper; the **Codex** coarse-or-deferred decision.

### 11.2 C1 spike outcome (2026-06-05) — RESOLVED with per-harness adaptation; Codex is the real limit
The model **survives**, but the design's **uniform-mechanism assumption was wrong**. There is no single per-turn
channel; instead a **per-harness *acquisition adapter* feeds a uniform server contract** (a turn-delta POST).
Acquisition differs structurally:

| Harness | Per-turn surface | Mechanism | Cost | conv_id | Verdict |
|---|---|---|---|---|---|
| **Pi** | `turn_end`/`agent_end` event | completed `AgentMessage` **in-payload** | O(1) | stable `getSessionId()` | **FEASIBLE, no spike** |
| **Hermes** | `sync_turn(user, assistant)` | both halves handed in as args | O(1) | stable `session_id` | **FEASIBLE, no spike** (cleanest) |
| **OpenCode** | `event`→`message.updated`, flush on `session.idle` | accumulate by id; **avoid** `session.messages()` (no cursor, O(n)) | O(1) | stable `sessionID` | **FEASIBLE-WITH-CAVEATS** (idle-bracketing → live test; `event` hook unwired) |
| **Claude** | unwired `Stop` + `transcript_path` JSONL | slice from a **byte-offset** cursor | O(delta) w/ offset | stable `session_id` | **FEASIBLE-WITH-CAVEATS** (`transcript_path` presence/shape → live test) |
| **Codex** | `Stop` ("fires every turn"), payload unverified | n/a | — | **NONE** (only per-cwd fallback; `CODEX_RUN_ID` env-only + post-first-turn) | **BLOCKED** → coarser per-cwd capture, or excluded until upstream exposes a stable id |

**Consequences:**
- **Reframe (corrects D1/D7):** capture = a **per-harness acquisition adapter → uniform server contract**, *not*
  "the same per-turn injection channel everywhere" (that was the overstatement). The *output* (a per-turn delta,
  stably keyed) is uniform, so the **server contract (D8 buffer/cursor/extractor) is unaffected** — only the
  small per-plugin acquisition code differs.
- **Pi + Hermes are a proven floor** — in-payload, O(1), stable key, **no spike needed**. Ship those first.
- **D3 wording fix (I1):** the hook is a mechanical adapter (receive/slice a delta, skip `off_record`,
  fire-and-forget) — **no judgment, no agent burden** (D3's real intent) — but **not literally "dumb"** (it holds
  a cursor + slices). Reword D3 "no judgment / no agent," not "no logic."
- **Codex is the one genuine limitation** (I2 confirmed): no stable per-conversation id → a per-turn cursor can't
  attribute deltas; it gets coarse per-cwd capture or is deferred pending an upstream id.
- **Three maintainer-run live tests gate the build:** ① Claude `Stop`+`transcript_path` (exists? append-only?);
  ② Codex `Stop` payload + any stable id; ③ OpenCode `session.idle` brackets exactly one assistant turn.

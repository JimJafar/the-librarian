# ADR 0009 — Make Librarian use automatic at the harness boundary: deterministic capture + awareness injection, with a narrow write-block

- **Status:** Proposed
- **Date:** 2026-06-16
- **Revises:** the 2026-06-14 draft of this ADR, which made a broad file-write
  veto the *primary* mechanism. This rewrite inverts that: automatic capture +
  awareness injection are the primary levers; the write-block narrows to a
  supplement. The motivating evidence (below) is unchanged; the leverage analysis
  is corrected.
- **Related:** ADR 0006 (agent-facing MCP surface), ADR 0007 (the rethink — the
  primer as canonical teaching surface D9; private mode D11; in-tree integrations
  D14). Grounded in the 2026-06-05 working doc
  `docs/research/harness-driven-capture-brainstorm.md` (idea A capture, idea B
  awareness; decisions D6/D7/D8/D9; the §11.2 per-harness capability audit), whose
  auto-capture track the owner shelved as "unsure + huge change" and this ADR
  revives. Does **not** change the 7-verb surface, the protocols, or the memory
  state model.

## Context

The Librarian's whole value proposition is that it is **the** memory + handoff
layer — the default an agent reaches for on any harness, any machine, instead of
scribbling a file or using a harness's built-in note store. The teaching surface
meant to make that happen is the **primer** (ADR 0007 D9): served as the MCP
`initialize` `instructions` field and at `GET /primer.md`, plus each tool's
protocol-bearing description.

**That advice does not reliably change agent behavior.** The evidence is our own:
across three months of building this, agents — including the ones building it —
default to files. In a single recent session, an agent asked to "write a handoff
for a fresh session" wrote a flat `HANDOFF.md` into the repo **and** routed a
durable lesson into the local Claude Code file-memory store, with the *"you must
use the librarian instead"* instruction sitting in its context the entire time. It
only used the verbs after the human asked, twice, *"why aren't you using the
librarian?"* The mandate was present, injected, and ignored.

The failure is structural, not attitudinal. But the **earlier draft of this ADR
drew the wrong conclusion from it.** It reasoned: advice fails → the only
enforcement point is the harness boundary → therefore **block the file-writes**.
The first two steps are right; the third aims at the weakest available lever.

Two corrections, learned from how this is actually solved elsewhere (mem0 ships
exactly this for Claude Code in production) and from our own shelved 1A design:

1. **Saving and recalling are different problems and must be solved oppositely.**
   *Saving* is where agents are unreliable — they forget to call `remember`, or
   do it inconsistently, or only when nagged. A hook never forgets. So capture
   should be **automatic and deterministic**, taken off the agent entirely.
   *Recalling* is a judgment the agent is actually well-placed to make (it has the
   conversation; a hook script does not) — so recall should be **nudged and made
   visible**, not forced.
2. **A file-write block solves neither.** Denying a `Write` to `HANDOFF.md` does
   not make the agent *recall* at the right moment, and it captures **nothing** the
   agent didn't already decide to write down. It only closes one egress. In mem0's
   shipping plugin the equivalent block exists but is deliberately narrow — it
   intercepts only the *competing* native memory store (`MEMORY.md`), and the
   actual driver of consistent use is automatic background capture plus awareness
   injection. The block is a supplement, not the engine.

So the gap is concrete and the fix is mis-aimed in the prior draft: the place that
*can* act (the integration's harness hooks) should be made to **capture
automatically and inject awareness**, with a *narrow* block guarding the one
channel that competes with us — not a broad veto standing in for the whole
strategy.

## Decision

**The Librarian's harness integrations make memory use automatic at the harness
boundary**, in three layers — two primary, one supplementary — authored once in
this repo, version-controlled, and distributed by `librarian install`.

1. **Deterministic automatic capture (primary).** A per-turn hook ships the
   conversation **delta** to the server; the server redacts secrets on intake,
   appends to a per-conversation buffer, and — when the conversation **settles** —
   runs a single curator pass over the whole buffer to extract durable facts into
   the **existing** inbox→curator engine (the same async filing `remember` already
   feeds; this is the Librarian's equivalent of mem0's server-side `infer`). The
   agent spends **zero tokens** and makes **no decision** to save. Capture is
   **default-on**, suppressed under private mode and by a `LIBRARIAN_AUTO_SAVE=false`
   kill-switch.

2. **Awareness injection (primary, paired).** Sharpen the server-sourced primer
   and surface a deterministic, visible nudge so the agent *knows* it has
   `recall`/`remember` and is prompted to recall when prior context may exist —
   especially after compaction. Retrieval remains the agent's call (it has the
   context to judge relevance); we nudge hard, we do not force.

3. **Narrow write-block (supplement).** A pre-action hook blocks **only** writes
   to the harness's *native* memory store (in Claude Code: `**/.claude/**/memory/**`
   and `MEMORY.md` therein), redirecting to the Librarian. It does **not** police
   handoff-shaped filenames or arbitrary notes — that breadth was the prior draft's
   over-reach. It guards the single channel that competes with us, nothing more.

**Architecture:** one **uniform server-side transcript-intake contract** plus
**thin per-harness acquisition adapters**. Acquisition differs structurally by
harness (Claude tails `transcript_path`; Pi/Hermes receive the completed turn
in-payload; OpenCode brackets on idle — per the §11.2 audit), but the *output* —
a per-turn delta, stably keyed — is uniform, so the server pipeline is built once.
We build and **dogfood Claude-first**, then add adapters for Pi/Hermes/OpenCode
against the same contract; Codex is deferred (no stable per-conversation id).

This does **not** touch the 7-verb MCP surface, the handoff/takeover protocols, the
memory state model, or the primer's role as canonical teaching. It obeys the sacred
rules: **fail-soft** (a capture/guard error never blocks the user's turn — and on
any uncertainty the capture path errs toward *not* capturing); **private mode**
(per-turn `[librarian:private=on]` turns are skipped at acquisition, redaction runs
before any disk write, and nothing is silently converted into server state); and
**cross-harness contracts change together** (the server contract and the
primer/private-mode touchpoints are designed for all harnesses now, even though the
adapters land incrementally).

## Consequences

**Positive**

- The behavior the product depends on **stops depending on agent discretion** at
  the point where agents are unreliable (saving), while leaving judgment where the
  agent is strong (recall). The old block-only approach closed neither gap.
- **Reuses the existing engine.** The inbox→curator pipeline already does
  async dedupe/merge/file; capture adds an intake door + a settle-sweep in front of
  it, not a new extraction system. The Librarian's curator *is* the `infer` step.
- **Dogfoods the thesis.** The system that curates an agent's memory also ensures
  the agent feeds it — observed daily in the one harness the owner actually uses.
- **Awareness + capture compose.** Together they address both "never saves" and
  "never recalls"; the narrow block removes the one competing attractor.

**Negative / costs**

- **New server-side LLM cost** (extraction) that scales with transcript volume.
  Accepted for the baseline: single-user, text-only, batched once per settled
  conversation, and bounded by the settle-sweep (brainstorm D10). A multi-user
  install may want a cap — documented as a scaling consideration, not built now.
- **Raw conversation transits to the server automatically** — a real privacy
  surface that the agent-mediated model didn't have. Mitigated by: per-turn private
  skip, **redaction-on-intake before any write** (brainstorm D6), a **sidecar
  buffer kept out of the git vault and deleted after extraction** (D8), and the
  `LIBRARIAN_AUTO_SAVE=false` kill-switch. **Default-on is a deliberate choice that
  reverses the 2026-06-05 D2 (default-off/opt-in)** — justified because default-off
  perpetuates the exact "never used unless asked" failure this ADR exists to fix,
  and because the mitigations above make automatic capture privacy-defensible.
  Privacy is the product; this trade-off is made with eyes open and is reversible
  via the kill-switch and (later) a dashboard toggle.
- **Extraction-quality risk** (hallucinated or context-stripped memories). Bounded
  by routing auto-captured candidates through the curator's normal **confidence
  bands** — high-confidence applies, low-confidence proposes for review — plus
  whole-conversation extraction and cross-segment merge to keep a lesson with its
  context.
- **Not uniform across harnesses.** Authoritative, in-payload capture on Pi/Hermes;
  feasible-with-a-live-test on Claude/OpenCode; **Codex is blocked** (no stable
  conv_id) and gets coarse/deferred treatment. We ship an honest capability matrix.
- **Maintenance surface.** A server capture pipeline + the settle-sweep + per-harness
  acquisition adapters + the narrow block — new code across the server and each
  integration, under the drift-guard discipline.

**Threat model (explicit):** this targets the *cooperating-agent-forgets* failure —
a well-meaning agent that simply doesn't save or recall reliably. It is **not** an
adversarial control: an agent (or user) that wants to evade capture can. That's
fine; the goal is to make the right thing automatic, not to defeat a hostile client.

## Alternatives considered

- **A broad file-write veto as the primary mechanism (the 2026-06-14 draft).**
  Rejected as the *primary* lever: blocking a write makes the agent neither recall
  nor capture anything it didn't already decide to write; it closes one egress and
  leaves the structural problem intact. **Demoted** to the narrow native-store block
  (layer 3) — useful, but a supplement.
- **More advice only (sharpen the primer / add a SessionStart reminder).** This is
  the layer that already failed when relied on alone. **Kept** as the awareness
  layer (it is necessary — a reliability floor, since the skill/plugin may not even
  auto-load), but never relied on as the whole answer.
- **Enforce server-side.** Impossible: the MCP server sees only MCP calls and cannot
  observe or veto a harness file-write or a missed `remember`.
- **Agent-driven capture (`/learn`, manual `remember`).** Rejected as primary:
  unreliable (the agent forgets) and disruptive (it interrupts the user's
  conversation pace to do extraction work). **Kept** as a manual escape hatch /
  on-demand flush; its role narrows from *the* capture path to a fallback.
- **Big-bang capture at session end.** Rejected: there is no reliable session-end
  signal across harnesses (users close the app, `/clear`, abandon). Per-turn
  incremental ingestion + a server-side settle-sweep loses at most the last turn and
  needs no end event.
- **Build all five harnesses at once.** Rejected: the plan would move at the speed
  of its worst harness (Codex is blocked), and an untuned mechanism replicated five
  ways means debugging the same edge cases in five places. Claude-first against a
  uniform contract ships a dogfoodable slice without foreclosing the rest.

# Spec 039 — Curator entity-granularity guidance (node vs facet; hub-and-spoke)

**Status:** Draft for review (Specify phase) — pick up as a subsequent piece of work
**Version target:** PATCH/MINOR (consolidator prompt + eval fixtures; opt-in feature, no default-runtime change)
**Depends on:** the consolidator (036 Phase 4, shipped), the v2 curation prompt (shipped), `@librarian/consolidator-eval` (C6, shipped)
**Relates to:** `scripts/seed/` (the wipe-and-re-import loop this spec is measured by — see its README); `docs/TODO.md` "Curator retrospective refactoring" (the corpus-level counterpart this does NOT cover)

---

## Objective

**What.** Sharpen the consolidator judge's **entity-granularity** decision so the
graph it builds has the right *nodes*: a distinct entity (a person, project,
company, system) gets its **own node, linked to its hub**, while a new *facet* of
an existing topic **augments** the existing node — and a fact's *kind* routes it
to the right node (a person-specific fact → the person's node; a structural fact →
the hub).

**Why.** The judge already decides create-vs-augment, but nothing tells it *how
granular a node should be*. From the 2026-06-03 design conversation: the owner
wants hub-and-spoke knowledge — e.g. a **Team** hub plus a node **per team member**,
where each member's node carries person-specific detail and the team/company facts
stay on the hub. The current prompt leaves "is this a new entity, or a new facet?"
to undirected LLM discretion, and its preserve/augment-first bias can pile
person-specific facts onto a hub instead of spinning out a clean spoke. This makes
the *emergent graph* fuzzier than it should be — and because backlink-aware recall
is one-hop (verified), a fact orphaned on the wrong node or left unlinked is
genuinely harder to retrieve.

**Who.** The owner + any user whose memory grows into entity clusters (people,
projects, systems). Improves the opt-in consolidator only.

**Success, in one line.** Given a "Team" hub and an incoming person-specific fact,
the judge **creates (or augments) the person's spoke node and `[[wikilinks]]` it to
the hub**, rather than burying the fact in the hub — and the `consolidator-eval`
metrics show this measurably, not anecdotally.

---

## Background — what's there, and the gap

- The judge sees the relevant candidate docs **and** a table-of-contents of the
  whole corpus, then emits one action (`create`/`augment`/`supersede`/`archive`/
  `noop`) with a confidence. So the create-vs-augment *mechanism* exists.
- A `create`d node can embed `[[Hub]]` in its body; wikilinks resolve to docs by
  **title/alias**, and recall expands **one hop** over inbound+outbound edges
  (the "Anna problem" recall is built + tested). So hub↔spoke linking *works* once
  the link text is present.
- **Gap:** no guidance on *node granularity*. The prompt doesn't say "a distinct
  entity deserves its own node; a new facet augments," doesn't distinguish
  person-specific from structural facts, and gives no spin-out heuristic. Result:
  granularity is undirected and the augment-first bias under-creates spokes.

This is the **per-submission** half of the granularity problem. The
**corpus-level** half — retrospectively splitting a node that already grew too
coarse — is explicitly out of scope here (see the TODO item).

---

## The change

### 1. Prompt — add an "entity granularity" section to the judge `SYSTEM_INSTRUCTIONS`

Bump `CONSOLIDATOR_PROMPT_VERSION` (v2 → v3). Add guidance, roughly:

- **A distinct entity deserves its own node.** A person, project, company, team,
  system, or place that the submission is *primarily about* should be its **own
  doc**, even if a related hub already exists. A new *facet* of an entity that
  already has a node → **augment** that node.
- **Hub-and-spoke + routing by kind.** When both a hub (e.g. "Team at Expend") and a
  spoke (e.g. "Brett") are plausible homes, route by what the fact is *about*:
  **person/entity-specific** detail → the **spoke**; **structural / relational**
  detail (who reports to whom, team composition) → the **hub**. Don't put
  person-specific facts on the hub.
- **Spin out, then link.** If the right entity has **no node yet** and the fact is
  primarily about it, `create` that node and put `[[Hub]]` in its body so the edge
  forms — prefer this over augmenting the hub with an entity-specific fact.
- **But don't over-fragment.** A genuine *facet* (one more preference, one more
  detail about the same thing) augments; only spin out when the submission is
  substantively about a *distinct* entity. (This is the counterweight that keeps
  "preserve/augment-first" intact for true facets.)

Keep the OUTPUT CONTRACT, the code-enforced RULES, and the untrusted-data framing
unchanged (as v2 did). This is additive judgement guidance.

### 2. Eval — entity-granularity fixtures + a metric in `consolidator-eval`

Add a **synthetic** scenario set (no personal data) modelling hub-and-spoke:

- A "Team" hub exists; an incoming **person-specific** fact about a member with **no
  node yet** → expect `create` (a spoke) — NOT `augment` the hub.
- The member's node exists; another **person-specific** fact → expect `augment` the
  **spoke** (not the hub).
- A **structural** fact (team composition) → expect `augment` the **hub**.
- A genuine **facet** of an existing single-entity node → expect `augment` (the
  anti-over-fragmentation guard).

Add a metric (e.g. `node_granularity` / `hub_spoke_routing`): the fraction of
granularity fixtures where the judge picked the right node-vs-facet action and the
right target — surfaced by `consolidator-eval` so the `scripts/seed` wipe-and-re-import loop can track it.

---

## Commands / Project Structure / Testing

- **Touches:** `packages/core/src/consolidator/judge-step.ts` (the prompt + version),
  `packages/core/tests/consolidator-judge-step.test.ts` (pin the new guidance present),
  `packages/consolidator-eval/fixtures/` + `src/metrics.ts` (the granularity scenarios + metric).
- **Testing:** offline, the prompt-build test pins the v3 guidance strings; the
  eval scenarios are scored with the scripted `LlmClient` for the *plumbing*, and
  with a **real model** in the operator iterate loop for the *quality* number (the
  prompt change cannot be quality-validated offline — same caveat as v2).
- **Code style / boundaries:** synthetic fixtures only; additive prompt change; no
  change to the output contract or code-enforced rules; opt-in consolidator only.

## Success Criteria

- [ ] v3 prompt carries explicit entity-node / hub-spoke / spin-out guidance; the prompt-build test pins it; offline consolidator tests stay green.
- [ ] `consolidator-eval` has hub-and-spoke granularity fixtures + a granularity metric, runnable in the `scripts/seed` wipe-and-re-import loop.
- [ ] On a real-model run, the granularity metric is **measurable and improved vs v2** (the operator records the before/after — this is the proof, and it can only be produced by a real-model run).
- [ ] The "don't over-fragment" guard holds: a genuine facet still augments (a fixture proves the prompt didn't swing to over-creating).

## Open Questions

1. **How explicit to make "kinds"?** Name concrete entity kinds (person / project /
   company / system / place) in the prompt, or keep it abstract ("a distinct
   entity")? Concrete may anchor better but risks missing kinds.
2. **Confidence interaction.** Should "spin out a new entity node" lean on the
   existing low-confidence→`create_new` band, or is spin-out a *high*-confidence
   `create`? (They're different: create_new files the raw submission and drops the
   judgment; an intentional spoke wants the judge's curated title/body + the `[[Hub]]`
   link.) Likely the latter — confirm.
3. **Does this want a navigate change too?** For the judge to choose the right
   spoke, navigate must surface both the hub and any existing spokes as candidates.
   Confirm recall + ToC reliably surface sibling spokes at the relevant corpus size,
   or whether navigate needs entity-aware candidate selection (bigger; likely a
   follow-up).

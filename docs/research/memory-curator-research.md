# Memory Curator — Research

> **Superseded by the spec.** This is the original research/exploration doc. The implemented design lives in [`docs/specs/memory-curator-spec.md`](../specs/memory-curator-spec.md); the build followed [`docs/specs/implementation-plan.md`](../specs/implementation-plan.md). Where this doc and the spec disagree, the spec wins. Kept for provenance — read the spec for current behaviour.

**Author:** Guybrush, with Jim
**Date:** 2026-05-23
**Status:** Research — superseded by `docs/specs/memory-curator-spec.md`

---

## 1. Executive conclusion

The v1 feature should be a **scheduled internal memory curator** for The Librarian. It should not be a new agent tool, not a transcript processor, and not a broader session-storage project.

The right v1 is deliberately narrow:

1. Deduplicate near-identical memories.
2. Merge fragmented memories and split conflated ones.
3. Archive stale, contradicted, or low-signal memories.
4. Surface durable facts from existing stored session evidence.

The earlier draft was mostly pointing the right way, but it still had three design faults:

- it retained stale references to agent-facing maintenance MCP tools even while saying curation should be internal;
- it described private data as something to filter inside curation, which is wrong — off-record private conversations must never touch The Librarian at all;
- it treated LLM confidence as enough to auto-apply all operation types, which is too trusting for destructive or identity-adjacent memory edits.

The improved design is an **internal worker/system feature**. Agents see only the curated memory store through normal `start_context` and `recall`. Neither agents nor users can trigger, list, cancel, or inspect curation runs through a feature-specific surface.

---

## 2. Terminology that matters

The word “private” is overloaded, so the implementation must be explicit.

| Term | Meaning | Stored in The Librarian? | Curator input? |
|---|---|---:|---:|
| **Off-record private conversation** | Jim says “this is private”, “don’t remember this”, “off the record”, or starts with a private harness mode. | **No** | **No** |
| **`agent_private` visibility** | Stored data visible only to the originating agent. Existing Librarian visibility concept. | Yes | Only in same visibility slice |
| **`common` visibility** | Stored data shared across agents. | Yes | Yes |

Jim’s requirement is about the first row: an off-record private conversation has **zero interaction with The Librarian**. No `start_context`, no `start_session`, no events, no memories, no later filtering. The curator cannot leak what it never receives.

The existing `agent_private` visibility is still useful for stored but non-shared agent notes. The curator must not merge `agent_private` evidence into `common` memories unless an explicit governed migration design says so.

---

## 3. Current data available to v1

The current system has enough structured data for a useful first pass without adding more session capture.

| Input | Usefulness | Notes |
|---|---|---|
| Active memories | Primary | The curator’s main job is to improve these. |
| Proposed memories | High | Often already pre-curated; may be duplicates or need merging. |
| Archived memory titles/metadata | Medium | Useful as tombstones to avoid recreating facts deliberately archived earlier. Full archived bodies are not normally needed. |
| Session start/rolling/end summaries | Medium | Narrative context; uneven quality. |
| Session decisions arrays | Very high | Structured durable facts that often deserve memory promotion. |
| Session candidate memories | Very high | Agent already marked these as memory-worthy. |
| Files touched / commands run | Low-medium | Helps interpret decisions; not memory content by itself. |
| Raw transcripts | Out of scope | Not currently wanted for v1; brings privacy and storage questions. |

The curation quality will be highest for engineering conventions and explicit decisions. It will be weaker for implicit preferences and subtle design reasoning because those often live in raw conversation, not summaries.

That is acceptable for v1. The goal is not perfect autobiographical memory; it is lower-noise operational memory.

---

## 4. Memory quality failures to target

The current store can degrade in predictable ways.

**Duplication.** The same fact is written multiple times with different phrasing. This wastes context and makes recall feel noisy.

**Fragmentation.** Related facts are split across entries that are only useful together. A project’s test framework, command, and coverage convention may be stored as three separate low-context memories.

**Conflation.** One memory contains several unrelated facts. This makes retrieval imprecise and updates dangerous.

**Staleness.** A once-true fact becomes false or obsolete: old Node versions, superseded decisions, temporary “considering X” notes after X was accepted or rejected.

**Session orphans.** A session checkpoint records a durable decision, but no memory was ever created. This is especially likely when the human or agent forgot to promote candidates at session end.

**Identity/relationship crowding.** Important durable context can be buried beneath technical trivia. The curator should not silently rewrite protected memories, but it can surface low-signal technical clutter that is crowding recall.

---

## 5. Architecture options considered

### Option A — Agent-facing MCP memory-curation tools

Rejected. Agent-facing memory-curation MCP tools would expose an internal maintenance process to ordinary agents. That creates several problems:

- agents could spend tokens triggering maintenance rather than doing user work;
- curation prompts and outputs become part of normal agent context;
- private-mode boundaries become harder to reason about;
- it adds a new public API before the internal behaviour has matured.

Curation should be internal. Agents should only observe the result indirectly through improved `recall` and `start_context`.

### Option B — Anthropic-style rebuild of a parallel memory store

Rejected for v1. A full rebuilt store reviewed and adopted as a unit is elegant, but too heavy for The Librarian now. It would require parallel stores, a large review surface, rollback/adoption flows, and more dashboard work.

The Librarian already has governed memory operations, proposal states, protected categories, and an audit trail. The curator should produce **small memory operations** against the existing store.

### Option C — In-process scheduler in the MCP server

Viable, but not the strongest default. It is simple, but long LLM jobs inside the MCP server process increase coupling. If the server is ever horizontally scaled, in-process cron can also double-run without a lock.

If used, it must acquire a database lock and run strictly out-of-band from request handling.

### Option D — Internal scheduler/worker in application code

Preferred. Implement curation as internal library code called only by trusted Librarian runtime paths: a scheduler tick, evidence-threshold checks, and bounded maintenance/test code. Do not expose a CLI command, dashboard trigger, MCP tool, or slash command. The MCP tool registry and user command surfaces remain unchanged.

This keeps the feature internal, testable, and deployable without giving either agents or users a curation control surface.

---

## 6. Trigger strategy

A good trigger policy should avoid both over-curation and memory rot.

| Trigger | Recommendation | Reasoning |
|---|---|---|
| Scheduled internal job | Daily or weekly, configurable | Keeps the store from rotting without depending on agents or user action. |
| Evidence threshold | Run after N eligible sessions or M memory writes since the last successful run | Reacts when there is enough new material to justify an LLM pass. |
| Trusted maintenance path | Internal-only, bounded | Useful for deployment/bootstrap/tests, but not a public command. |
| Manual user/admin trigger | No | Curation should be policy-driven hygiene, not a feature Jim or an agent operates. |
| Agent MCP tool | No | Explicitly out of scope. |

For v1, a conservative default is: **run once daily, but only process a slice if it has at least 10 new eligible sessions or 7 days since last curation**. These numbers should be config, not constants.

“Eligible” means stored, non-ended? No — ended sessions still contain evidence. It means stored sessions in the target visibility/project slice that have not already been included in a successful curation run. Off-record private conversations are not eligible because they do not exist in the store.

---

## 7. Input slicing

The curator should not process the whole world at once. A run operates over a **slice**:

- `project_key = <key>` for project-specific memories and sessions;
- `project_key = null` / `scope = global` for global memories;
- optionally `agent_id = <agent>` for `agent_private` data.

Do not merge across slices by default. In particular:

- project memories must not be merged into global memories unless the operation is explicitly a “promote to global” proposal;
- `agent_private` memories must not become `common` through ordinary curation;
- cross-project pattern detection is v2+ and opt-in.

This slicing matters because memory correctness is contextual. “Use pnpm” may be true for one repo and false for another.

---

## 8. Operation model

The curator should output a validated operation list, not free prose. Operation types:

| Operation | Meaning | Default application policy |
|---|---|---|
| `noop` | Keep memory as-is; useful for audit only | Recorded, not applied. |
| `archive` | Soft-archive stale, duplicate, contradicted, or low-signal memory | Auto-apply only for exact/near duplicate or clearly superseded non-protected memories; otherwise propose. |
| `update` | Rewrite one memory for precision/currentness without changing its scope/category | Auto-apply only for low-risk wording/category cleanup; propose for semantic changes. |
| `merge` | Create one focused memory and archive the source memories | Auto-apply only when all sources are same category/scope/visibility and high-confidence; propose otherwise. |
| `split` | Replace one conflated memory with several focused memories | Usually propose; easy for an LLM to over-split. |
| `create` | Create a new durable memory from session evidence | Usually propose; auto-apply only for ordinary technical/project facts with strong direct evidence. |

Protected categories (`identity`, `relationship`, and any future protected class) always route to proposals regardless of confidence.

LLM confidence is not a proof of correctness. It is a prioritisation signal. Application policy must also consider operation type, category, visibility, evidence strength, and whether the edit destroys or merely adds information.

---

## 9. Safety and audit

The curator is maintenance automation, so it needs a visible audit trail.

Minimum audit fields per run:

- run id;
- slice (`project_key`, `visibility`, optional `agent_id`);
- trigger reason;
- input session ids and memory ids;
- input hash for idempotency;
- model/provider and token usage;
- summary;
- operation list;
- per-operation status: `proposed`, `applied`, `skipped`, `failed`;
- memory ids created/updated/archived by each operation;
- errors.

Every memory mutation should still flow through existing store methods so existing memory events, status transitions, proposal rules, and verification history remain intact. The curator should not run SQL updates that bypass the normal memory lifecycle.

---

## 10. Relation to session lifecycle automation

Session lifecycle automation is adjacent but separate.

The curator can only work with stored session evidence. Better session automation will eventually improve its inputs, but v1 should not wait for that. Jim explicitly asked not to add more session storage right now.

The session problem should be designed separately around:

- explicit privacy/off-record modes;
- harness commands;
- harness hooks;
- agent-driven start/checkpoint policy;
- conservative auto-pause rather than ambiguous auto-end.

The Memory Curator should not try to infer missing session boundaries. It should process whatever session evidence exists.

---

## 11. Open questions

1. **Default auto-apply level.** Should v1 default to proposal-only for the first few runs, then enable safe auto-apply after Jim trusts it?
2. **Model.** Which configured LLM should run curation? Local models may be fine for duplicates; stronger models are safer for split/merge decisions.
3. **Tombstone depth.** How much archived-memory data should the prompt include to avoid resurrecting old facts without bloating context?
4. **Review representation.** Which curator outputs can safely become ordinary memory proposals, and which should remain internal audit-only until a later review design?
5. **Metrics.** How should `verify_memory` outcomes feed back into curator quality scoring?

---

## 12. Recommended v1

Build the smallest useful internal curator:

- internal library module for gathering evidence, generating operations, validating, and applying;
- internal scheduler/worker trigger only; no CLI, dashboard, MCP, slash-command, or prompt-triggered control surface;
- scheduled and threshold-based execution from trusted application code;
- project/global/agent-private slices;
- operation-level audit table;
- conservative auto-apply policy;
- protected categories always proposed;
- no transcript capture;
- no session storage changes;
- no filtering of off-record private data because off-record private data is never stored.

That gives Jim the thing he actually asked for: better memory hygiene now, without expanding the session system prematurely.

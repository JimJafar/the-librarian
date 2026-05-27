# Spec: Memory-Classifier Implementation

**Author:** Claude, with Jim
**Date:** 2026-05-27
**Status:** Draft v2 — async lifecycle; configurable provider (local default, remote alternative); two-tier eval; collapsed shadow+cutover into one PR; awaiting implementation

---

## 1. Purpose

The parent spec ([`memory-domain-isolation-and-conv-state.md`](./memory-domain-isolation-and-conv-state.md) §4.4, §9, §21) introduces a write-path classifier — a small LLM that examines every new memory and decides the two new policy booleans, `is_global` and `requires_approval`. This document fills the gap §9 explicitly left open and, in three places, **departs from** the parent spec where downstream design work surfaced a better path. The departures are explicit:

- **Async classification, not sync** (parent §4.4 said "sync on the write path"). `remember` writes the memory with conservative defaults and returns immediately; a background worker classifies. See §4.1.
- **Configurable provider, not local-only** (parent §4.4 implied local). Admins choose local (default) or a remote OpenAI-compatible API via the existing curator LLM client infrastructure. See §4.2.
- **One PR, no shadow/cutover phase** (parent §7.3 / plan §6 + §7 staged it). The shadow phase was risk management for multi-user installs; for the current single-user shape we collapse the work into one PR with a backfill of existing memories. See §7.

If/when the parent spec gets a second pass, these three deltas should propagate up to it. Until then, this document is the source of truth for the classifier surface.

The parent spec items this document treats as fixed:

- **Two-boolean output** — the classifier decides `is_global` and `requires_approval`, nothing else.
- **Conservative fallback values** — `requires_approval=true, is_global=false` on any failure or before classification completes.
- **Owner override is ground truth** — every dashboard override appends `memory.classification_overridden`, the original verdict is preserved.
- **`memory.classified` events go to `events.jsonl`** as the eval substrate.

---

## 2. Non-goals

- **Not a general-purpose classifier.** Two booleans, one task. No tag suggestions, no recall re-ranking, no summary generation in the same surface.
- **Not retrainable from this repo.** Stock open-weights checkpoints + prompt engineering. If empirical quality demands a tuned model later, it's a follow-up sub-spec; the eval harness defined here is the substrate that decision would be made on.
- **Not exposed to agents.** Agents see only the booleans on the resulting memory. They never call the classifier, never see the raw verdict, never see the prompt version.
- **Not user-configurable at the prompt level.** Owner overrides individual verdicts via the dashboard; the prompt itself evolves through development-time releases gated by the eval harness.

---

## 3. Background

The parent spec §4.4 settled the principle ("a small LLM decides the two write-path booleans, owner-overridable"); §9 deferred specific model choice, serving topology, prompt versioning, and eval harness; plan §6 marked all of that as hard pre-work for the rollout.

Two insights surfaced during this spec's drafting that changed the architecture:

- **Sync was a constraint, not a requirement.** Nothing in the agent surface or the durability story actually needed the verdict to land synchronously. Decoupling them removes the dominant risk in the original sync design (the 500ms latency budget on a Thinking-variant model) without weakening any guarantee.
- **The Librarian already has an LLM-client abstraction.** The curator (`packages/core/src/curator-llm-client.ts` + `curator-config.ts`) already speaks to OpenAI-compatible endpoints with encrypted token storage. Making the classifier provider configurable costs almost nothing and lets the Librarian run on low-spec hardware that can't host a local model.

Both decisions are made in this spec, not deferred.

---

## 4. The contract

### 4.1 Async classification lifecycle

`remember` returns instantly with the memory persisted at conservative defaults. A background worker classifies; results commit later.

**Per-memory state machine:**

```
remember()                 worker run                worker run (retry)
   │                          │                            │
   ▼                          ▼                            ▼
classified=0              classifier ok?               attempts ≥ 3?
attempts=0                ─ yes ──▶ classified=1       ─ yes ──▶ classified=1
status=proposed                    + verdict booleans            + conservative
requires_approval=true             + memory.classified           + memory.classified
is_global=false                                                    fallback_used=
                          ─ no ──▶ attempts++                       "max_retries"
                                    classified=0
```

**The `memories` table gains two columns** (additive PR ahead of any worker code):

- `classified INTEGER NOT NULL DEFAULT 0` — `1` once the classifier has either produced a verdict or given up after `max_retries`.
- `classification_attempts INTEGER NOT NULL DEFAULT 0` — survives server restarts; incremented per failed attempt; capped at 3 before giveup.

**No separate queue.** The projection *is* the queue. The worker polls:

```sql
SELECT id FROM memories
WHERE classified = 0
ORDER BY created_at
LIMIT 1
```

processes the one row, updates it. Single classifier instance = single inference in flight = no race possible. A crash mid-inference leaves the row at `classified=0` and the next worker iteration picks it up (at most one wasted inference).

**Worker pacing.** Idle: poll every 500ms. Busy: process back-to-back with no sleep. The poll is a single indexed query; cost is negligible.

**Per-item timeout: 30s, killable.** Generous enough that even a slow local model never gets cut off mid-thought. If it times out, `classification_attempts++` and the row stays `classified=0` for the next iteration.

**Give-up after 3 failed attempts.** Set `classified=1` with the conservative-defaults verdict persisted (`requires_approval=true, is_global=false`) and emit a `memory.classified` event with `fallback_used: "max_retries"`. The memory ends up in the dashboard's proposal queue — the same place the owner would look for any pending review. Eval harness identifies these via the fallback flag and excludes them from agreement scoring.

**`remember`'s agent response is unchanged regardless of state.** Always "Memory saved." The agent's contract is "I wrote it durably" which is true the instant the row lands. Owner-side policy (proposed vs active, global vs scoped) is not the agent's concern.

**Intra-conversation race (acknowledged, accepted).** A `remember(X)` followed by `recall(query)` ~300ms later will miss X if X should have been global but isn't yet — conservative defaults give `is_global=0` + `status=proposed`, both of which fail the §4.11 recall filter. Cross-conversation recall is unaffected. The intra-conversation gap is small enough that the agent has X in its own context window anyway; documented as an explicit non-issue.

### 4.2 Configurable provider

Admins choose between two providers via a new dashboard setting. The default is local-on-this-machine; remote is the alternative for low-spec hardware or admins who already have an API key they prefer to use.

**`local`** — runs the model in-process via [`node-llama-cpp`](https://github.com/withcatai/node-llama-cpp), loaded into the existing `@librarian/mcp-server` process.

- Model loaded lazily on first classification call (or immediately on admin-enable, configurable). No model download until local mode is enabled.
- Runs on a Node worker thread (`worker_threads`) so other MCP calls stay responsive.
- Memory budget: up to 2GB RSS attributable to the classifier. Documented; the server should warn on startup if free RAM is <4GB.

**`remote`** — OpenAI-compatible HTTP API. Reuses the curator's LLM client code (`@librarian/core/curator-llm-client.ts`) but **with its own config**: endpoint, model name, encrypted token. An admin can run the classifier against GPT-4o-mini while the curator runs against Claude (or vice versa, or both against the same provider — fully decoupled).

**Configuration storage:**

- New admin settings keys, mirroring the curator's:
  - `classifier.provider` = `"local"` | `"remote"`
  - `classifier.local.model` (HuggingFace identifier or local path; default `LiquidAI/LFM2.5-1.2B-Thinking-GGUF`)
  - `classifier.local.quantisation` (default `Q4_K_M`)
  - `classifier.remote.endpoint`
  - `classifier.remote.model`
  - `classifier.remote.token` (encrypted via existing `secret-crypto`)
- Stored in the existing `settings` table; tokens encrypted; dashboard surface lives alongside the curator config page.
- Provider switch is hot-swappable. The next classification run uses whatever's current. In-flight retries keep the provider they were started with (the `memory.classified` event records which provider produced the verdict).

**Reuse, not duplication.** The internal LLM-client abstraction is shared between curator and classifier. Only the config (which provider, which endpoint, which model) is separate.

**Memory-content leakage warning.** Remote mode sends memory titles + bodies to a third party. The dashboard config page explicitly says so when the admin selects `remote`. A future redaction layer (out of scope for V1) may gate classifier inputs through the existing `curator-redaction` module; for now, it's an admin-informed trade-off.

### 4.3 Default local model

**[LiquidAI/LFM2.5-1.2B-Thinking-GGUF](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Thinking-GGUF)** — 1.2B-parameter Liquid Foundation Model with chain-of-thought, GGUF-packaged for native llama.cpp loading.

- **Quantisation:** Q4_K_M default (~700MB on disk, ~1.5GB resident with KV cache). Q8_0 is the fallback if Q4 quality is empirically poor against the calibration set.
- **Why this model.** Small enough to load anywhere; open weights; designed for edge inference. The Thinking variant has chain-of-thought headroom for the two-boolean decision without a 7B-class memory footprint.
- **The async lifecycle eliminates the latency budget.** The Thinking variant can think as long as it needs (within the 30s per-item ceiling). No prompt-side thinking-budget constraint, no contingency ladder for "the model is too slow" — slow but correct is exactly what async classification was designed for.

### 4.4 Prompt design + versioning

**Prompt files** live in `@librarian/classifier/prompt/v<N>.md`. The file path *is* the version identifier. Each `memory.classified` event records which version produced the verdict.

**Prompt shape (v1, normative):**

```
You classify durable memories for a personal memory store. For each
memory, decide two booleans:

- requires_approval: true if the memory contains identity facts,
  relationship facts, or anything an owner would want to review
  before it becomes active. False otherwise.
- is_global: true if the memory should bypass per-conversation domain
  filtering and be available everywhere (identity, relationships,
  preferences). False if it's contextual to a specific domain (tools,
  projects, lessons, environment).

Think as long as you need. When ready, output a single line:
{"requires_approval": <bool>, "is_global": <bool>}

The parser reads only the last JSON object on stdout; reasoning before
that line is ignored.

Few-shot examples:
[... 4–6 examples covering each {requires_approval, is_global} quadrant ...]

Now classify:
TITLE: {{title}}
BODY: {{body}}
TAGS: {{tags}}
```

**No thinking-budget constraint.** Async lifecycle means we want the model's best work, not its fastest work. The eval harness reports per-call inference time so we can see whether thinking is helping; the choice is data-driven, not budget-driven.

**Versioning workflow:**

- Adding `v2.md` doesn't deploy it. The classifier reads `LIBRARIAN_CLASSIFIER_PROMPT_VERSION ?? latest_committed`. A dashboard switch (admin-only) promotes a version.
- The eval harness can replay any past `memory.classified` event against any prompt version, so "would v2 have changed this decision?" is answerable before promotion.
- Prompt changes that shift verdicts materially land alongside a CHANGELOG entry + an eval-harness diff.

### 4.5 Output schema + validation

The model is prompted to output a JSON object on its last line: `{"requires_approval": bool, "is_global": bool}`. The parser:

1. Trims everything before the last `{` and after the matching `}` on the last line.
2. Runs `JSON.parse` and validates against a Zod schema (two booleans, exactly those keys, no extras).
3. On any parse / schema failure, treats this attempt as a failure → `classification_attempts++`, retry on the next worker iteration. Eventually hits the max-retries giveup at attempt 3.

The Thinking variant's reasoning preamble is discarded by step (1). Remote providers that don't emit chain-of-thought just emit the JSON directly — same parser, same code path.

### 4.6 Eval harness — two-tier

**Tier 1: public synthetic fixture.** ~900 memories committed to the repo, OSS-safe, no real PII. CI gates on this. See §4.7 for generation. Catches gross classifier regressions in public PRs from contributors who don't have access to the calibration set.

**Tier 2: private calibration set.** The canonical instance's real memories — initially the owner's hand-labelled ~200, growing organically as `memory.classification_overridden` events accumulate. Lives only in the canonical instance. Runs nightly (or per-release) in the operator's private environment. Catches the subtle regressions the synthetic set won't see.

**Tier-1 acceptance:** agreement vs labelled ground truth must not drop by >2 percentage points on the public fixture from one PR to the next, joint across both booleans, without an explicit override line in the PR description. Reports per-boolean breakdown alongside.

**Tier-2 trust signal:** the operator runs the private eval before tagging releases. If tier-1 and tier-2 disagree (tier-1 green, tier-2 regressed), tier-2 wins — the public fixture is a proxy, the private one is reality.

**Eval harness CLI** (`@librarian/classifier-eval`):

- `eval public` — runs the model against the committed synthetic fixture, prints agreement + latency stats.
- `eval private --data-dir <path>` — runs against the operator's `events.jsonl`, treating owner-override events as ground truth.
- `eval replay --event-id <id> --prompt v2` — re-runs a single historical event against a different prompt version, prints both verdicts.
- `eval generate-fixture --candidates 1500 --target 900` — generates a new candidate fixture (used during fixture refresh; see §4.7).

**Per-call telemetry recorded by every eval run:**

- Provider + model identity (which one ran it).
- Inference time (model think + response).
- Prompt version.
- Fixture entry id + the fixture's labelled answer.
- Classifier's verdict.

### 4.7 Public fixture generation

The public synthetic fixture is generated by a multi-model consensus filter — multiple strong models grade each candidate, only candidates where all models agree on the label survive. Eliminates per-model bias and produces high-confidence labels.

**Generation pipeline:**

1. **Generate candidates** with a strong LLM, prompted to produce a 60/40 split of straight vs boundary cases:
   - **Straight cases** (60%): clear examples of each `{requires_approval, is_global}` quadrant. ~900 candidates.
   - **Boundary cases** (40%): things that *look* like one quadrant but belong in another (a tool-shaped note that contains a relationship fact; an identity-shaped note that's actually a preference). **Over-generate boundaries — expect ~50% survival under consensus vs ~80% for straight cases**, so generate ~1000 boundary candidates to yield ~400 survivors.

2. **Consensus filter.** Run each candidate through 3 frontier models from different families (Claude Sonnet, GPT-4o, Gemini 2.x). Keep only candidates where all three models agree on both booleans. If a candidate has any disagreement, drop it.

3. **Trim to ~900 maintaining the 60/40 ratio.** If boundary survivors come up short (e.g. 250 boundary, 750 straight), generate another boundary batch and re-filter. Iterate until both buckets meet target.

4. **Commit the fixture** as JSON to the repo:
   ```json
   [
     {
       "id": "fix_<uuid>",
       "title": "...",
       "body": "...",
       "tags": [...],
       "label": { "requires_approval": false, "is_global": false },
       "category": "straight" | "boundary",
       "consensus_models": ["claude-sonnet-x", "gpt-4o", "gemini-2.x"]
     },
     ...
   ]
   ```

5. **Refresh cadence.** Manually, when the classifier prompt evolves materially or when fixture coverage proves inadequate (a regression slips through CI). Not automated.

**Provenance.** The CHANGELOG records which generation models / versions produced each fixture refresh. If a model is deprecated or significantly updated, a refresh is appropriate.

**No ambiguous cases.** Items where reasonable graders disagree contribute no signal to the eval and burn compute — explicitly excluded. (See §9 if we ever want to test "calibrated uncertainty"; out of scope for V1.)

### 4.8 `memory.classified` event shape

```json
{
  "event_type": "memory.classified",
  "event_id": "evt_<uuid>",
  "memory_id": "mem_<uuid>",
  "agent_id": "<resolved>",
  "created_at": "<iso>",
  "payload": {
    "input": { "title": "...", "body": "...", "tags": [...] },
    "provider": "local" | "remote",
    "model": "LiquidAI/LFM2.5-1.2B-Thinking-GGUF" | "gpt-4o-mini" | ...,
    "model_quant": "Q4_K_M" | null,
    "prompt_version": "v1",
    "raw_output": "<full model text incl. thinking>",
    "parsed": { "requires_approval": false, "is_global": false } | null,
    "fallback_used": false | "timeout" | "parse" | "provider_unavailable" | "max_retries",
    "queue_wait_ms": 47,
    "inference_ms": 1832,
    "attempt_number": 1
  }
}
```

`raw_output` is the eval substrate — kept indefinitely. ~500B per event × 100 writes/day = ~50KB/day = ~18MB/year. Log rotation is a follow-up if the volume ever becomes a concern.

`queue_wait_ms` + `inference_ms` are reported separately so the eval harness can distinguish "the queue was deep" from "the model was slow."

---

## 5. Tech stack

- **New package:** `@librarian/classifier` — owns the worker, the provider router (local vs remote), the prompt files, the JSON parser, the retry + giveup wrapper. Exports `runOnce(deps)` for the worker tick and `classify({title, body, tags}, providerConfig)` for the eval harness.
- **New package:** `@librarian/classifier-eval` — CLI for public + private eval, fixture generator, CI runner.
- **New runtime dep:** [`node-llama-cpp`](https://github.com/withcatai/node-llama-cpp) — only loaded when `classifier.provider === "local"`. Pinned to a specific minor; native module; must build cleanly on Apple Silicon / Linux x86_64 / Linux aarch64.
- **Reused:** `@librarian/core`'s LLM-client abstraction (the curator's). The classifier consumes the same client code with its own config namespace.
- **Reused:** `secret-crypto.ts` for encrypted token storage.
- **No new database surface beyond the two new `memories` columns** (`classified`, `classification_attempts`). Verdicts ride existing JSONL events; the projection columns from PR 1 are already in place.
- **Dashboard:** the classifier config page extends the existing curator settings UI (same component, separate config namespace). Provider toggle, model/endpoint/token inputs, prompt-version dropdown.

---

## 6. Decisions

- **D1.** **Async lifecycle.** Conservative defaults at write time; background worker classifies; no latency budget on the agent path.
- **D2.** **`classified` boolean + `classification_attempts` integer** on the `memories` table. Simpler than tri-state; retry count survives restarts.
- **D3.** **No separate queue.** Worker polls the projection (`WHERE classified=0`). Single classifier instance, sequential, crash-safe by construction.
- **D4.** **30-second per-item timeout, 3 retries, then giveup.** Giveup marks `classified=1` with conservative defaults and emits `memory.classified` with `fallback_used: "max_retries"`.
- **D5.** **Configurable provider** (local | remote OpenAI-compatible). Reuses the curator's LLM client *code*; has its own *config* so admins can use different providers/models for the two jobs.
- **D6.** **Local default: LFM2.5-1.2B-Thinking-GGUF, Q4_K_M.** No thinking-budget constraint; async absorbs the latency.
- **D7.** **Two-tier eval:** public synthetic fixture in repo (CI gate), private calibration set on the operator's instance (release gate).
- **D8.** **Public fixture by multi-model consensus filter** (Claude + GPT-4o + Gemini, unanimous). 60/40 straight/boundary; over-generate boundaries to survive pruning. No ambiguous cases.
- **D9.** **Backfill on migration.** Existing memories are marked `classified=0` at upgrade time and the worker drains the queue over the first hours/days. Verdicts replace the legacy category-derived booleans where they disagree.
- **D10.** **Agent response from `remember` is always "Memory saved"** regardless of classification state. The agent's contract is durability, not policy.
- **D11.** **No shadow phase.** PR 6 + PR 7 from the parent plan collapse into one. Risk management is: the synth eval gates CI; the operator manually reviews the dashboard during week one; PR revert + bridge restore is the rollback path.

---

## 7. Migration / rollout

**One PR, not two.** Collapses the parent plan's PR 6 (shadow) + PR 7 (cutover) into a single PR that ships the classifier as source of truth from merge time. The category-derived bridge code is deleted in the same PR.

**Contents:**

- New `@librarian/classifier` package (worker + provider router + prompt files + parser).
- New `@librarian/classifier-eval` package (CLI + fixture generator + CI runner).
- New columns on `memories`: `classified`, `classification_attempts`. Schema version bumped.
- Worker started by `@librarian/mcp-server` on boot (in-process; same supervision as the existing curator scheduler).
- Dashboard settings page for classifier provider + model + token + prompt version.
- Removal of the legacy `deriveLegacyMemoryFlags` code path in `@librarian/core/constants.ts`.
- Migration: existing memories get `classified=0, classification_attempts=0`. Pre-existing booleans (set by the legacy bridge during PR 1's migration) remain in place as the "before" snapshot for the eval; the worker overwrites them with the classifier's verdict on first run.
- Public fixture committed to `packages/classifier-eval/fixtures/public-v1.json`.
- CHANGELOG entry.

**Backfill rollout on the canonical instance:** ~200 memories × p99 inference time = expected total < 2 hours of background load on first boot post-merge. The owner watches the dashboard during the backfill; visible disagreements between the legacy verdict and the classifier's verdict are the first real eval data, and inform whether the model / prompt are working.

**Rollback path:**

- Revert the PR.
- The migration's downgrade re-derives the legacy booleans from `category` on the next mcp-server boot (deterministic — same code that produced them in PR 1).
- The `memory.classified` events from the failed run stay in the ledger but are inert because the projection no longer reads them. Eval data preserved for post-mortem.
- The new `classified` / `classification_attempts` columns get dropped on downgrade (next schema version bump removes them).

---

## 8. Success criteria

- [ ] `remember` returns "Memory saved" in <50ms p99, with the row at conservative defaults and `classified=0`.
- [ ] The background worker drains `WHERE classified=0` rows sequentially without blocking the mcp-server's other MCP calls.
- [ ] Per-item 30s timeout enforced; 3 retries before giveup; giveup emits `memory.classified` with `fallback_used: "max_retries"`.
- [ ] Crash-mid-inference leaves the row at `classified=0` and the next worker iteration re-processes it (at most one wasted inference).
- [ ] Provider switch (local ↔ remote) is hot-swappable via the dashboard; in-flight retries keep their original provider.
- [ ] Every `memory.classified` event includes provider, model, prompt version, queue_wait_ms, inference_ms, attempt_number, fallback_used. Owner-overrides emit `memory.classification_overridden` preserving the classifier's original verdict.
- [ ] Backfill of the canonical instance's ~200 existing memories completes within hours of the upgrade, with classifier verdicts visible in the dashboard alongside the legacy-derived "before" snapshot.
- [ ] The eval harness's public-fixture run produces a regression report; CI gates PRs that drop joint agreement by >2 percentage points without an explicit override.
- [ ] The eval harness's private-calibration run produces the same shape of report against the canonical instance's `events.jsonl`, using owner-override events as ground truth.
- [ ] The dashboard's proposal-queue view shows `requires_approval=true AND classified=1` memories — `classified=0` ones don't appear until the worker has decided.
- [ ] On a fresh install with `classifier.provider="remote"`, no local-model download is triggered; the install footprint is unchanged from pre-classifier mcp-server.
- [ ] On a fresh install with `classifier.provider="local"`, the model is downloaded lazily on first classification call (or immediately on admin-enable, configurable).

---

## 9. Open questions

- **Boundary case survival rate under consensus.** ~50% is the working assumption; the first batch will tell us. If it's <30% we over-generate harder; if it's >70% the boundary cases probably aren't boundary enough — we tighten the synth prompt.
- **Remote-mode input redaction.** Out of scope for V1: should the classifier's inputs (memory title + body) flow through `curator-redaction` before being sent to a third-party provider? Probably yes; not blocking initial release. The dashboard UI for remote-mode explicitly says "contents leave your machine" so admins choosing remote know what they're trading away.
- **Worker-process isolation.** The worker runs in-process on a Node worker thread. For multi-user or multi-process supervision scenarios we'd want a separate process or even a separate machine; not for V1.
- **Backfill performance regression.** If backfill of 200 memories takes much longer than the 2-hour estimate (e.g. local mode on a Raspberry Pi), the owner-facing experience on day one is "the dashboard says half my memories are still unclassified." Acceptable for V1 — the worker will catch up — but worth noting that for low-spec hosts, remote mode is the practical default.
- **What happens to the parent spec.** `memory-domain-isolation-and-conv-state.md` §4.4 + §7.3 + §8 contain language inconsistent with this document (sync, shadow phase, latency budget). They should be updated in the same PR as the classifier implementation lands, with cross-references to this spec for the detailed contract.

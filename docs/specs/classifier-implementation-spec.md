# Spec: Memory-Classifier Implementation

**Author:** Claude, with Jim
**Date:** 2026-05-27
**Status:** Draft v1 — model + serving chosen (LFM2.5-1.2B-Thinking-GGUF, in-process); eval harness + prompt versioning pinned; awaiting implementation

---

## 1. Purpose

The parent spec ([`memory-domain-isolation-and-conv-state.md`](./memory-domain-isolation-and-conv-state.md) §4.4, §9, §21) introduces a write-path classifier — a small local LLM that examines every new memory and decides the two new policy booleans, `is_global` and `requires_approval`. This document fills the gap §9 explicitly left open: which model, how it's served, how its prompt is versioned, and how its quality is measured and watched in production.

The parent spec already nails down four things this document treats as fixed:

- **Behaviour contract** — sync on the write path of `remember`; 500ms timeout; conservative fallback (`requires_approval=true, is_global=false`); `memory.classified` event appended to `events.jsonl` on every call.
- **Owner override** — every dashboard toggle of either boolean appends a `memory.classification_overridden` event preserving the classifier's original verdict.
- **Cutover order** — PR 6 ships in shadow mode (classifier verdicts logged, persisted booleans still come from the category-derived bridge); PR 7 flips the source of truth. This document targets the PR 6 + PR 7 work but does not redefine that order.
- **No retroactive reclassification at migration time** — historical memories keep their migrated values until and unless an opt-in admin tool fires the classifier across them.

Anything outside those four is in scope here.

---

## 2. Non-goals

- **Not a general-purpose classifier.** This model decides *exactly* two booleans for a single classification task. We're not adding tag suggestions, summary generation, or recall re-ranking in the same surface.
- **Not retrainable from this repo.** We use a stock open-weights checkpoint with prompt engineering, not fine-tuning. If empirical quality demands a tuned model later, that's a follow-up sub-spec; the eval harness defined here is the substrate that decision would be made on.
- **Not exposed to agents.** Agents see only `requires_approval`/`is_global` on the resulting memory. They never call the classifier directly, never see the raw verdict text, never see the prompt version.
- **Not configurable at the prompt level for end users.** The owner can override individual verdicts via the dashboard (and that override is the eval ground truth); they cannot edit the prompt. Prompt evolution is a development-time activity gated by the eval harness.

---

## 3. Background

The parent spec §4.4 settled the principle ("a small local LLM decides the two write-path booleans, owner-overridable") and §9 deferred the implementation details ("specific model choice, serving infrastructure, prompt versioning workflow, eval harness specification"). The rollout plan §6 makes this document a hard pre-work blocker for Phase 6 ("shadow mode"): nothing in PR 6 can land until the model and serving topology are committed.

The legacy bridge in [PR 1 / T1.3](./memory-domain-isolation-and-conv-state-plan.md) gives us a behavioural baseline: every existing and PR 1-era memory has booleans derived from the old `category` enum. That baseline doubles as the migration-shaped eval set — we already know the "right" booleans for every historical memory, so the classifier's first-day job is to agree with the derivation, not to outperform it. The classifier's actual value shows up later, when it generalises *beyond* the seven category values into the new tag-driven world post-cutover.

---

## 4. The contract

### 4.1 Model choice

**[LiquidAI/LFM2.5-1.2B-Thinking-GGUF](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Thinking-GGUF)** — 1.2B-parameter Liquid Foundation Model variant with chain-of-thought ("Thinking") reasoning, packaged as GGUF for native llama.cpp / node-llama-cpp loading.

- **Why this model.** Small enough to load in the same Node process as the mcp-server (≤2GB RAM at the recommended quantisation), open weights, and the architecture is designed for edge inference. The "Thinking" variant gives us internal reasoning headroom for the two-boolean decision without paying a 7B-class memory or latency cost.
- **Quantisation.** Default Q4_K_M (~700MB on disk, fits in ~1.5GB RAM with KV cache). Fallback to Q8_0 if Q4 quality is empirically poor; Q2_K is below the floor we'll accept.
- **Risk we're accepting.** Thinking-variant models tokenise their internal reasoning before the final answer. The 500ms budget includes that reasoning time. The prompt (see §4.3) explicitly constrains the thinking budget; the eval harness (§4.6) measures latency including the thinking block. If empirical p99 latency exceeds 500ms on the reference hardware, we either constrain thinking further or switch to a non-Thinking sibling variant. This is the dominant Open Question for PR 6 shadow mode — see §9.

### 4.2 Serving topology

**In-process** via [`node-llama-cpp`](https://github.com/withcatai/node-llama-cpp), loaded into the existing `@librarian/mcp-server` process.

- **Why in-process.** One process to deploy, one config file to manage, no IPC failure mode. The Librarian's whole pitch is "portable memory layer that runs anywhere" — a separate sidecar service breaks that.
- **Cold start.** Lazy-loaded on the first `remember` call. The mcp-server startup time is unchanged; the first user write pays a one-time ~2s model load. Subsequent calls are warm.
- **Memory budget.** Up to 2GB RSS attributable to the classifier. Documented in the server's operational guidance; the mcp-server should warn on startup if the system has <4GB free.
- **Worker thread.** The inference call runs on a Node worker thread (`worker_threads`) so the main event loop stays responsive to other MCP requests during the (up to) 500ms classification window. Without this, every `remember` would block the server for everyone.
- **Concurrent calls.** A single model instance is reused across requests; concurrent inferences serialise through llama.cpp's batch queue. This is fine for the expected single-owner workload; if we ever hit multi-tenant scale, we revisit.

### 4.3 Prompt design + versioning

**Prompt lives in `@librarian/classifier/prompt/v<N>.md`** as plain markdown. Each prompt version is a committed file; the file path *is* the version identifier. Every `memory.classified` event records which version produced the verdict.

**Prompt shape** (v1, normative):

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

Output strictly:

{"requires_approval": <bool>, "is_global": <bool>}

Think briefly (≤30 tokens) before answering. Do not include the
thinking in the JSON output — the parser reads only the final line.

Few-shot examples:
[... 4–6 examples covering each quadrant ...]

Now classify:
TITLE: {{title}}
BODY: {{body}}
TAGS: {{tags}}
```

**Versioning workflow:**

- Adding a new prompt file (`v2.md`) does *not* deploy it. The classifier defaults to `LIBRARIAN_CLASSIFIER_PROMPT_VERSION ?? latest committed`. A dashboard switch (admin-only) flips the active version.
- The eval harness (§4.6) can replay any past `memory.classified` event against any prompt version, so we can answer "would v2 have changed this decision?" before promoting v2.
- Prompt changes that materially shift verdicts must land alongside a CHANGELOG entry and an eval-harness diff showing the new agreement rate.

### 4.4 Output schema + validation

The model is prompted to output a single-line JSON object: `{"requires_approval": bool, "is_global": bool}`. The parser:

1. Trims everything before the last `{` and after the matching `}`.
2. Runs `JSON.parse` and validates the result against a Zod schema (two booleans, exactly those keys, no extras).
3. On any parse / schema failure, treats it as a model failure and falls through to the conservative fallback (§4.5).

The Thinking variant's reasoning preamble is discarded by step (1). If the model emits multiple JSON objects, the last one wins (the model's "final answer" by convention).

### 4.5 Latency + reliability budget

- **Timeout:** 500ms per `remember` call (parent spec §4.4 — fixed).
- **Target p99 (warm):** <300ms. The 200ms headroom absorbs an occasional slow turn or a busy host.
- **Fallback (parent spec D20 — fixed):** on timeout / malformed output / model unavailable, persist `{requires_approval: true, is_global: false}` and append a `memory.classified` event with `fallback_used: true`.
- **Cold-start exemption:** the first `remember` after server start may exceed 500ms while the model loads. The classifier returns the fallback for that one call (with `fallback_used: "cold_start"` for observability) and is warm by the next.
- **Loud failures (parent spec §4.4 — fixed):** the dashboard's proposal queue surfaces every memory that landed via the fallback, with a "classifier was down" tag, so the owner sees that the safety net is engaging.

### 4.6 Eval harness

A new package `@librarian/classifier-eval` (CLI + test fixtures) that:

1. **Reads `events.jsonl`** and selects every `memory.classified` event (each carries the input title/body/tags, the raw model output, the parsed verdict, and the prompt version).
2. **For each event, optionally reruns** against a chosen prompt version (`--prompt v2`) and/or a chosen model variant (`--model …`). Produces a row: `{event_id, ground_truth, original_verdict, replayed_verdict, replayed_latency_ms}`.
3. **Ground truth** is the most authoritative of: an explicit `memory.classification_overridden` event (owner override), else the legacy category-derived booleans (until they're removed in PR 7), else `null` (no signal — not counted in agreement).
4. **Reports:**
   - Overall agreement rate vs ground truth (per boolean and joint).
   - Disagreement breakdown by category / domain / age.
   - Latency distribution (p50 / p95 / p99 / max, separated for warm vs first-after-load).
   - Fallback rate.
5. **CI integration:** every PR that touches `packages/classifier/` or `packages/mcp-server/src/mcp/tools/remember.ts` runs the harness against a checked-in 1000-memory fixture (anonymised, derived from the canonical instance). Regression threshold: agreement on the fixture must not drop by >2 percentage points vs the previous baseline without an explicit override line in the PR description.

### 4.7 `memory.classified` event shape

Recorded on every `remember` call (shadow mode and post-cutover alike) per parent spec §4.4:

```json
{
  "event_type": "memory.classified",
  "event_id": "evt_<uuid>",
  "memory_id": "mem_<uuid>",
  "agent_id": "<resolved>",
  "created_at": "<iso>",
  "payload": {
    "input": { "title": "...", "body": "...", "tags": [...] },
    "model": "LiquidAI/LFM2.5-1.2B-Thinking-GGUF",
    "model_quant": "Q4_K_M",
    "prompt_version": "v1",
    "raw_output": "<full model text incl. thinking>",
    "parsed": { "requires_approval": false, "is_global": false } | null,
    "fallback_used": false | "timeout" | "parse" | "model_unavailable" | "cold_start",
    "latency_ms": 187
  }
}
```

The `raw_output` is the eval substrate — we keep it indefinitely. At ~500B per event × 100 memories/day = ~50KB/day on `events.jsonl`. If this proves too expensive over years, we'll add a `--rotate-classified-events` migration that trims old entries to a sampled subset; not in V1 scope.

---

## 5. Tech stack

- **New package:** `@librarian/classifier` — owns the model lifecycle, the prompt files, the JSON parser, the timeout + fallback wrapper. Exports a single `classify({title, body, tags}): Promise<ClassifyResult>` function. Test-mockable via a deterministic stub.
- **New package:** `@librarian/classifier-eval` — CLI for the eval harness, plus the CI runner.
- **New runtime dep:** [`node-llama-cpp`](https://github.com/withcatai/node-llama-cpp) (current major; pinned to a specific minor in `package.json`). Native module; we'll need to confirm it builds cleanly on Apple Silicon, Linux x86_64, and Linux aarch64 — the same platforms the mcp-server supports.
- **Model checkpoint:** downloaded at install time (`pnpm install` hook) or lazily on first server start (preferred — keeps `pnpm install` offline-friendly). Cache lives under `~/.librarian/models/<model-name>/`.
- **No new database surface.** Verdicts ride existing JSONL events; the projection-level columns (`is_global`, `requires_approval`) are already in place from PR 1.

---

## 6. Decisions

- **D1.** Model: LFM2.5-1.2B-Thinking-GGUF. Rationale in §4.1; the dominant risk is the Thinking-variant latency, mitigated by the eval-harness latency report and the §9 contingency.
- **D2.** Serving: in-process via node-llama-cpp on a worker thread. Rationale in §4.2.
- **D3.** Quantisation: Q4_K_M default, with Q8_0 as the empirical-quality fallback.
- **D4.** Prompt files are the version identifier. Each `memory.classified` event records the path. Single active version at a time, admin-switchable.
- **D5.** JSON output, schema-validated. Multiple objects → last one wins. Parse failure → conservative fallback.
- **D6.** Eval harness reads `events.jsonl`; ground truth is owner-override-first, category-derived-second. CI gate: agreement on the fixture cannot drop >2 percentage points without an explicit override.
- **D7.** Cold-start latency is exempted from the 500ms budget — the first post-restart `remember` gets the fallback with `fallback_used: "cold_start"`. Operators can warm the classifier with a dummy call at startup if cold-start fallbacks are unwanted.
- **D8.** Model download is lazy on first server start (not at `pnpm install`). Keeps installs offline-friendly and lets operators on a metered connection control the download moment.

---

## 7. Migration / rollout

- **Phase 6 (PR 6, classifier shadow mode)** — ship `@librarian/classifier`; wire it into `remember` to run on every write and log a `memory.classified` event; persisted booleans still come from the legacy bridge. Dashboard gains the "classifier-vs-derived disagreement" view from rollout plan §T6.3. Owner reviews quality over a week+; eval-harness summary is the go/no-go signal.
- **Phase 7 (PR 7, cutover)** — flip the source of truth. The classifier's verdict becomes the persisted booleans; the legacy `category`-derived path is deleted. Plan-defined acceptance: ≥95% agreement on the fixture, p99 latency <300ms warm, fallback rate <2%.
- **No data migration required for this spec.** PR 1 already wired the columns. PR 6 starts logging the events. PR 7 starts persisting the verdicts.

---

## 8. Success criteria

- [ ] `@librarian/classifier.classify({...})` returns within 500ms (warm) for >99% of calls on the reference hardware (M2 MacBook Air, 16GB RAM; Linux x86_64, 4 vCPU, 8GB RAM).
- [ ] Every `remember` call appends exactly one `memory.classified` event. The payload includes the raw model output, the parsed verdict, the model + quant + prompt version, the latency, and the fallback flag.
- [ ] The conservative fallback fires on every model failure path (timeout, parse, schema, model-unavailable, cold-start) and is observable on the dashboard.
- [ ] The eval harness can replay any historical event against any committed prompt version and any installed model variant.
- [ ] The classifier-quality CI gate runs on every relevant PR and blocks merges that regress agreement by >2 percentage points without an explicit override.
- [ ] The first-time install of mcp-server on a fresh machine downloads the model lazily on first `remember` (offline-friendly install).
- [ ] Spec §4.4's existing success criterion is satisfied: "An owner toggling `is_global` or `requires_approval` on a memory via the dashboard records a `memory.classification_overridden` event preserving the classifier's original verdict." (Already in the parent spec; this document inherits it.)
- [ ] The mcp-server's startup self-test verifies the classifier package is loadable and the configured model exists or downloads, exiting non-zero if either is broken (loud failure on install misconfiguration).

---

## 9. Open questions

- **Thinking-variant latency.** LFM2.5-1.2B-Thinking includes a chain-of-thought preamble. We are explicitly choosing this model for its reasoning headroom on a small parameter count, but the 500ms budget *includes* the thinking time. **Contingency:** if PR 6 shadow-mode latency exceeds 500ms p99 on either reference machine, the eval harness will compare against:
  1. A more aggressive prompt-side thinking constraint (≤15 tokens of internal reasoning).
  2. The non-Thinking sibling variant (LFM2.5-1.2B base, if published).
  3. Qwen2.5-0.5B-Instruct as a smaller / faster alternative.

  The decision is taken once we have warm-call latency numbers from the fixture, not before.

- **Quantisation floor.** Q4_K_M is the default but we don't know yet whether classification quality holds at that quantisation on this specific architecture. PR 6's shadow-mode evidence answers this — if Q4 disagreement is materially worse than Q8 against the migration baseline, we ship Q8 (~1.2GB on disk, ~2.2GB resident) instead.

- **`memory.classified` event volume.** At ~500B × 100 writes/day = ~50KB/day = ~18MB/year. Acceptable. Past three years (~55MB) we should look at log rotation; not now.

- **CI fixture provenance.** The 1000-memory eval fixture has to come from real-world data to be meaningful, but cannot include any PII or owner-specific content. Open: build a derivation pipeline that pulls from the canonical instance, redacts via the existing `curator-redaction` module, and commits the result. PR 6 blocker — but a small one.

- **Worker-thread concurrency under load.** node-llama-cpp's batch queue serialises concurrent calls; the worker thread keeps the main event loop responsive. Open: is there a non-trivial workload where two concurrent `remember`s queue badly? Probably not for single-owner use; revisit if we ever multi-tenant.

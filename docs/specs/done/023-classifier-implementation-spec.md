# Spec: Memory-Classifier Implementation

> **Partially superseded by [`032-remove-local-classifier-spec.md`](./032-remove-local-classifier-spec.md).**
> The local (GGUF / node-llama-cpp) provider, the curated model catalog, and
> the `providerMode` discriminator described below were removed; the classifier
> is remote-only. Kept for provenance — read 032 for current behaviour.

**Author:** Claude, with Jim
**Date:** 2026-05-27
**Status:** Draft v4 — async lifecycle; configurable provider (local default, remote alternative); curated local-model catalog with custom-HF override (LFM2.5-1.2B-Instruct as default, not Thinking); dashboard-driven evaluation; collapsed shadow+cutover into one PR; ready for review

---

## 1. Purpose

The parent spec ([`022-memory-domain-isolation-and-conv-state.md`](./022-memory-domain-isolation-and-conv-state.md) §4.4, §9, §21) introduces a write-path classifier — a small LLM that examines every new memory and decides the two new policy booleans, `is_global` and `requires_approval`. This document fills the gap §9 explicitly left open and, in three places, **departs from** the parent spec where downstream design work surfaced a better path. The departures are explicit:

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
  - `classifier.local.model` (HuggingFace identifier or local path; default `LiquidAI/LFM2.5-1.2B-Instruct-GGUF` — see §4.3 catalog)
  - `classifier.local.quantisation` (default `Q4_K_M`)
  - `classifier.remote.endpoint`
  - `classifier.remote.model`
  - `classifier.remote.token` (encrypted via existing `secret-crypto`)
- Stored in the existing `settings` table; tokens encrypted; dashboard surface lives alongside the curator config page.
- Provider switch is hot-swappable. The next classification run uses whatever's current. In-flight retries keep the provider they were started with (the `memory.classified` event records which provider produced the verdict).

**Reuse, not duplication.** The internal LLM-client abstraction is shared between curator and classifier. Only the config (which provider, which endpoint, which model) is separate.

**Memory-content leakage warning.** Remote mode sends memory titles + bodies to a third party. The dashboard config page explicitly says so when the admin selects `remote`. A future redaction layer (out of scope for V1) may gate classifier inputs through the existing `curator-redaction` module; for now, it's an admin-informed trade-off.

### 4.3 Local model selection

Admins pick from a curated catalog of GGUF models or supply their own HuggingFace identifier. The catalog covers the practical range of hardware profiles — from Raspberry Pi to desktop — without forcing any particular choice. The dashboard evaluation tool (§4.6) is the natural pre-flight check before switching models in production.

**Curated catalog:**

| Model | Params | RAM (Q4_K_M) | License | Profile |
|---|---|---|---|---|
| [Qwen3.5-0.8B-Instruct-GGUF](https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF) | 0.8B | ~1GB | Apache 2.0 | **Smallest.** Raspberry Pi 4 and constrained hardware. Non-thinking mode only — the 0.8B Thinking variant has documented loop behaviours. |
| **[LFM2.5-1.2B-Instruct-GGUF](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF)** *(default)* | 1.2B | ~1.5GB | LFM1.0 | **Laptop default.** Best balance of size, quality, and structured-output reliability for the classifier's task. |
| [LFM2.5-1.2B-Thinking-GGUF](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Thinking-GGUF) | 1.2B | ~1.5GB | LFM1.0 | Same architecture as the default with chain-of-thought. Worth trying via the dashboard eval if Instruct misclassifies your boundary cases. Expect higher parse-failure rates; verify with the eval before promoting. |
| [Qwen3.5-2B-Instruct-GGUF](https://huggingface.co/unsloth/Qwen3.5-2B-GGUF) | 2B | ~2.5GB | Apache 2.0 | Mid-tier. Multimodal-capable (vision/audio inside the parameter count; not used by the classifier). MoE + Gated Delta Networks architecture; 262K context. |
| [Phi-4-mini-instruct-GGUF](https://huggingface.co/unsloth/Phi-4-mini-instruct-GGUF) | 3.8B | ~3.5GB | MIT | **Desktop choice for reasoning quality.** Strongest published benchmarks at this size class. Text-only, dense decoder-only (no MoE / multimodal complexity), 128K context, function calling. |
| [gemma-4-E2B-it-GGUF](https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF) | 2.3B effective | ~3.5GB | Apache 2.0 | Desktop. Multimodal (text/image/audio), configurable thinking, 128K context. |

All catalog entries use Unsloth's Dynamic 2.0 quantisation where available — meaningfully better than vanilla llama.cpp quants at small model sizes where Q2/Q3 starts to degrade. The recommended quantisation per model is Q4_K_M; Q8_0 is the fallback if Q4 classification quality is empirically poor on your real data (verifiable via the dashboard eval).

**Custom-model support.** Admins can paste any HuggingFace identifier (e.g. `org/model-GGUF`) into the dashboard. On save, the system downloads the model, loads it via node-llama-cpp, and runs a self-test prompt to confirm it produces parseable JSON before persisting the config. If the self-test fails, the admin sees the model output verbatim and can choose a different quant, model, or back out. No silent broken-classifier states.

**Picking guidance** (also surfaced inline on the dashboard config page):

- **Hardware-constrained?** Start with Qwen3.5-0.8B — half the RAM, still classifies two booleans reliably in non-thinking mode.
- **Default laptop install?** LFM2.5-1.2B-Instruct — selected by default. Run the dashboard eval on a 100-sample stratified subset within the first week to confirm it works for your real-data distribution.
- **Boundary-case performance matters more than speed?** Try Phi-4-mini if you have the RAM; its reasoning benchmarks are the strongest of the catalog.
- **Want to A/B Thinking vs Instruct?** Configure both as candidate / production, run the dashboard eval against each, promote the better one. The eval makes this a 10-minute exercise rather than a faith-based choice.

**License caveat on LFM2.5.** The LFM1.0 license is more restrictive than Apache/MIT — permissive for personal and small-commercial use, restrictive above a revenue threshold. For a personal-memory tool this is rarely relevant; for an organisational deployment, admins should check the LFM1.0 terms or choose an Apache/MIT alternative (Qwen3.5 or Phi-4-mini).

**Soft alert on high fallback rate.** The dashboard surfaces a warning when more than 20% of classifications in the last 100 hit `fallback_used: "max_retries"` — a strong signal that the configured model is producing malformed output. Catches the "admin enables a custom model that doesn't follow instructions, classifier silently degrades" failure mode without nagging during normal operation.

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

**Prompt is tuned for Instruct-style output by default.** The v1 prompt expects the model to emit JSON directly without a thinking preamble — the Instruct variants in the catalog produce exactly that shape. Admins who switch to a Thinking variant (e.g. LFM2.5-1.2B-Thinking) should run the dashboard eval before promoting it, because Thinking variants emit a chain-of-thought block ahead of the JSON. The parser handles both shapes (it trims to the last `{...}` block on the output), but Thinking variants have higher parse-failure rates if the model's CoT happens to include JSON-shaped text mid-thought. If the eval shows materially elevated `fallback_used: "parse"` rate against a Thinking model, a prompt variant tuned for explicit thinking-block delimiting may be needed — see §9.

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

### 4.6 Eval harness — operator-driven, not CI-driven

The eval surface is **a dashboard tool, not a CI gate**. Three reasons:

1. **Running 1000 classifications in CI is expensive.** Local-model CI runners don't have GPUs; remote-API CI burns through tokens on every PR. Neither is justifiable for a project this size.
2. **LLM non-determinism makes automated quality gates flaky.** Even with temperature=0 and pinned models, providers occasionally produce different outputs for the same input — every flake erodes trust in the gate.
3. **The operator's real signal comes from running memory through it.** Backfill on day one + daily use is the ground truth; a synthetic-fixture CI gate is a poor proxy for it and adds infrastructure cost in exchange.

CI tests the *machinery* — parser, retry logic, worker drain, migration backfill — with mocked models. Quality evaluation lives on the dashboard.

**What CI actually does** (mocked, deterministic, fast):

- Parser handles thinking-preamble + JSON, multiple JSON objects (last wins), malformed output (rejects with parse error), missing keys (rejects), extra keys (rejects).
- Worker correctly drains `WHERE classified=0`, increments `classification_attempts` on failure, gives up after 3 attempts with `fallback_used="max_retries"`, never double-processes a row.
- Migration backfill marks existing memories `classified=0, classification_attempts=0`.
- Provider router correctly dispatches to local vs remote based on config, including hot-swap mid-operation.
- All of the above run against a mock classifier (`{ classify: (input) => returnPresetVerdict(input) }`). Zero actual model invocations. <1s in CI.

**Dashboard evaluation surface:**

A new admin page, "Classifier Evaluation," lets the operator on-demand:

1. **Pick a provider + model** (defaults to the current production config; can select a candidate for comparison).
2. **Pick a sample size**: 10 (smoke test, ~1 minute), 100 (standard, ~10 minutes locally), or "all 1000" (deep eval, ~hours locally / ~minutes remote).
3. **Pick a category filter**: all, straight-only, boundary-only. Boundary-only is the harder eval and often the more informative one.
4. **Run.** Each sample is stratified-random from the fixture (proportional draw across `straight`/`boundary` unless the filter narrows it).
5. **See the report:**
   - Joint agreement (% of samples where both booleans match the fixture label).
   - Per-boolean agreement (one boolean might be reliable while the other isn't).
   - Disagreement breakdown by category (straight misses are alarming; boundary misses are expected at some rate).
   - Latency distribution (p50 / p95 / p99 / max).
   - Sample-level results table with diff highlighting so the operator can read the actual disagreements.

**Persisted between runs:**

- Each evaluation run writes a `classifier.evaluation_completed` event to the events ledger with the run parameters (provider, model, prompt_version, sample_size, filter) and the summary stats. The dashboard's history view shows the timeline.
- Sample-level disagreements are linked from the report — the operator can click a row to see the fixture entry, the classifier's verdict, and the fixture's labelled answer side by side. Useful for diagnosing "the model thinks identity facts are preferences" patterns.

**Natural workflow this enables:**

1. Operator wants to try a candidate model. They configure it in a "candidate" slot (not the production slot).
2. Dashboard → Classifier Evaluation → run 100-sample evaluation against the candidate.
3. Report says 94% agreement. Operator clicks the disagreements, sees they're mostly boundary cases on identity/preferences edges. Acceptable.
4. Operator promotes the candidate to production. Backfill behaviour or daily use is the longer-term signal.

If steps 2-3 produce bad results, the candidate never reaches production. No CI involved.

**Eval harness CLI** (`@librarian/classifier-eval`, the headless interface the dashboard calls into):

- `eval run --provider local --model <id> --sample 100 --category boundary` — runs an evaluation, prints the report as JSON. The dashboard wraps this; ops can also invoke it directly for scripting / cron.
- `eval replay --event-id <id> --prompt v2` — re-runs a single historical `memory.classified` event against a different prompt version. Useful for "would v2 have changed this decision?" spot checks.
- `eval generate-fixture --candidates 1500 --target 900` — generates a new candidate fixture via the §4.7 consensus pipeline. Used during refresh; not part of normal eval.

**Promotion is a deliberate admin action, gated by eval results.** Prompt changes (promote `v2`) and model swaps (production slot ↔ candidate slot) both require the admin to click a button. The natural-but-non-binding workflow is: change → eval → if happy, promote. There's no automated "block promotion if agreement drops" rule — the operator's judgement is the gate. (We can add a soft warning to the promote button: "Last evaluation was N days ago at X% joint agreement — run a fresh eval first?")

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
    "model": "LiquidAI/LFM2.5-1.2B-Instruct-GGUF" | "gpt-4o-mini" | ...,
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
- **New package:** `@librarian/classifier-eval` — CLI for dashboard-triggered evaluation, fixture generator, replay helper. The dashboard wraps the CLI; operators can also script against it.
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
- **D6.** **Local model: curated catalog with admin choice + custom-HF override.** Default is LFM2.5-1.2B-Instruct-GGUF at Q4_K_M for laptops; Qwen3.5-0.8B-Instruct for Pi-class hardware; Phi-4-mini-instruct for desktop where reasoning quality matters more than RAM. Instruct variants are preferred over Thinking for the classifier's structured-output task (cleaner JSON, lower parse-failure rate); admins can A/B the Thinking variant via the dashboard eval. Custom models are validated against a self-test prompt before persisting config to prevent silent broken-classifier states.
- **D7.** **Dashboard-driven evaluation, not CI quality gate.** CI tests the machinery (parser, retries, migration) with mocked models; the operator runs evaluation against the synthetic fixture from the dashboard when promoting prompts or candidate models. The eval is *advisory*, not blocking — the operator's judgement is the actual gate. Avoids the cost (local CI has no GPU; remote CI burns tokens) and the flakiness (LLM non-determinism) of automated quality gates. Backfill + day-to-day use is the real-data signal.
- **D8.** **Synthetic fixture by multi-model consensus filter** (Claude + GPT-4o + Gemini, unanimous). 60/40 straight/boundary; over-generate boundaries to survive pruning. No ambiguous cases. Lives in the repo; used by the dashboard evaluation tool, not by CI.
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
- [ ] CI runs the machinery tests (parser, worker, retries, migration) against mocked classifiers, in <5 seconds, with zero actual model invocations.
- [ ] The dashboard's "Classifier Evaluation" page lets the operator pick provider + model + sample size + category filter, runs the evaluation, and renders a report covering joint agreement, per-boolean agreement, disagreement breakdown, latency distribution, and sample-level diffs.
- [ ] Every evaluation run emits a `classifier.evaluation_completed` event so the dashboard's history view shows the timeline of runs and their results.
- [ ] The dashboard's proposal-queue view shows `requires_approval=true AND classified=1` memories — `classified=0` ones don't appear until the worker has decided.
- [ ] On a fresh install with `classifier.provider="remote"`, no local-model download is triggered; the install footprint is unchanged from pre-classifier mcp-server.
- [ ] On a fresh install with `classifier.provider="local"`, the model is downloaded lazily on first classification call (or immediately on admin-enable, configurable).

---

## 9. Open questions

- **Boundary case survival rate under consensus.** ~50% is the working assumption; the first batch will tell us. If it's <30% we over-generate harder; if it's >70% the boundary cases probably aren't boundary enough — we tighten the synth prompt.
- **Remote-mode input redaction.** Out of scope for V1: should the classifier's inputs (memory title + body) flow through `curator-redaction` before being sent to a third-party provider? Probably yes; not blocking initial release. The dashboard UI for remote-mode explicitly says "contents leave your machine" so admins choosing remote know what they're trading away.
- **Worker-process isolation.** The worker runs in-process on a Node worker thread. For multi-user or multi-process supervision scenarios we'd want a separate process or even a separate machine; not for V1.
- **Backfill performance on low-spec hosts.** A Pi-class machine running Qwen3.5-0.8B at Q4_K_M will still take several hours to backfill the canonical instance's ~200 memories. The owner-facing experience is "the dashboard shows N% classified, increasing over the next few hours." Acceptable but worth noting that low-spec hosts should consider configuring remote mode for backfill if they have an API key handy, then optionally switching to local for ongoing classifications.
- **Thinking-variant prompt tuning.** The v1 prompt assumes Instruct-style direct JSON output. If an admin runs the dashboard eval against a Thinking variant and sees elevated `fallback_used: "parse"` rates (the CoT block confusing the parser), a v2 prompt with explicit thinking-block delimiting (`<think>...</think>{...}`) might be warranted. Empirical question for V2.
- **Custom prompts per model.** Out of scope for V1: admins promote prompts from the in-repo `prompt/v<N>.md` library; they don't author their own. The escape hatch (fork the repo, edit the prompt) exists for power users. Revisit if catalog growth surfaces a model that needs a meaningfully different prompt shape.
- **What happens to the parent spec.** `022-memory-domain-isolation-and-conv-state.md` §4.4 + §7.3 + §8 are now in sync with this document. If either spec drifts in a future revision, the other should be brought along in the same PR — they cross-reference each other heavily.

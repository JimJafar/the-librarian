# Spec: Chunk the global consolidation slice (fix the unscoped grooming timeout)

**Source of truth for *why*:** live production diagnosis on `ssd-nodes` 2026-06-17 (curation-runs.json failures + container logs). This spec defines *what* and *how* for a single implementation run.

**Status:** Draft — owner review pending. Scoped as a `packages/core` change + tests + version bump.

---

## 1. Objective

The unscoped (`project_key = null`) grooming slice consolidates **every** unscoped memory in a **single** LLM call. Past ~80 memories that call exceeds the curator LLM timeout and the whole unscoped consolidation fails — permanently, because the set only grows.

> Bound every consolidation LLM call to a configurable maximum number of memories. When a slice exceeds that bound, split it into multiple deterministic sub-batches, each its own consolidation call/run, so every call stays under the timeout **and** the whole slice is covered (not truncated).

Success: an unscoped slice of 96 memories grooms to completion across several bounded calls with zero `llm_timeout`; coverage is total (no memory is silently dropped); unchanged sub-batches still skip via input-hash.

## 2. Root cause & evidence

- `packages/core/src/grooming-source-vault.ts:89` — `listSlices()` emits exactly one `common_global` slice for all unscoped memories (one `common_project` slice per project).
- `packages/core/src/grooming-worker.ts:99` — `options.llmClient.complete({ messages })` is a **single** call for the whole selected slice; no chunking.
- `packages/core/src/grooming-worker.ts:47` / `grooming-config.ts:119` — `DEFAULT_MAX_MEMORIES = 200`; the slice is `selectNewest(...).slice(0, limit)` (`grooming-source-vault.ts:107`) — i.e. a **truncating cap**, not a chunk.
- Default curator LLM timeout = **60s** (`packages/core/.../curator-llm-client`: "Falls back to 60s when unset").
- Production evidence (`/data/curation-runs.json`): `run_45da38cb` (82 unscoped mems → `llm_timeout`, 0 tokens), `run_d78c379e` (96 → `llm_timeout`). An earlier **78**-memory unscoped run completed. Grooming model was `deepseek-v4-pro` (now `deepseek-v4-flash` as operational mitigation — fix A, applied 2026-06-17).

Two defects, not one:
1. **Timeout** — oversized single call.
2. **Silent truncation** — even when it *doesn't* time out, `slice(0, limit)` means memories beyond `max_memories` are never consolidated/deduped. Chunking fixes both.

## 3. Tech stack (unchanged)

TypeScript, Node ≥22.5, pnpm monorepo (`packages/core`, `packages/mcp-server`); Vitest. No new deps.

## 4. Commands

```
Build:      pnpm build
Test:       pnpm --filter @librarian/core test
Lint:       pnpm lint
Typecheck:  pnpm typecheck
Guards:     pnpm check:test-count, pnpm check:release
```

## 5. Design

### 5.1 New config key

- `curator.grooming.chunk_size` (read in `grooming-config.ts` alongside `maxMemoriesPerRun`).
  - Default **30**; min 1; max = effective `max_memories`. Operator-configurable (dashboard + settings store; read-through, no restart).
  - `max_memories` keeps its meaning: the **ceiling on total memories considered per slice per run**. `chunk_size` is the **per-LLM-call** bound. With defaults a slice covers up to 200 memories across ⌈200/30⌉ = 7 calls.

### 5.2 Chunking in the worker

In `grooming-worker.ts`, after selecting the slice's memories (currently one batch → one `complete()`), split the selected, deterministically-ordered memory list into consecutive chunks of ≤ `chunk_size` and run the existing consolidation pipeline **per chunk**:

- Ordering MUST be stable (already `byUpdatedDesc` then `id` tiebreak — add the `id` tiebreak if not present) so chunk boundaries are reproducible and the input-hash skip stays valid.
- Each chunk computes its own `input_hash` (over its chunk's memory ids+content) and is skipped if unchanged since its last completed run (preserves the existing skip semantics, now per-chunk).
- Each chunk is its own curation **run** record (same `slice`, with a `chunk_index` / `chunk_count`), so a single slow/failed chunk is isolated: fail-soft per chunk, the others still complete (today one timeout fails the entire slice).
- Apply/judge/confidence policy is unchanged and applies per chunk.

### 5.3 Known limitation (document, don't solve here)

Two duplicate memories that land in **different** chunks won't merge within a single run. Acceptable: (a) ordering is stable so near-duplicates (similar `updated_at`) tend to co-locate; (b) the next scheduled run re-chunks as the set changes; (c) a future cross-chunk reconciliation pass can be specced separately. Call this out in the PR and the dashboard.

## 6. Tasks (test-first, one PR)

1. **Regression test (red first):** a slice of N=82 memories with `chunk_size=30` invokes `llmClient.complete` exactly ⌈82/30⌉ = 3 times, each with ≤30 memories; assert no single call exceeds `chunk_size`.
2. **Coverage test:** every selected memory appears in exactly one chunk (no drop, no dup across chunks); union over chunks = the capped selection.
3. **Isolation test:** one chunk's `complete()` rejecting (timeout) does not prevent the other chunks' runs from completing (fail-soft per chunk).
4. **Skip test:** an unchanged chunk is skipped via input-hash; changing one memory re-grooms only its chunk.
5. **Config test:** `curator.grooming.chunk_size` parses, defaults to 30, clamps to [1, max_memories]; read-through.
6. Implement chunking in `grooming-worker.ts`; add the config key in `grooming-config.ts`; thread `chunk_index/chunk_count` into the curation-run record type (`store/curation-types.ts`) and the dashboard run list (label chunked runs).
7. CHANGELOG entry under a new dated `## [X.Y.Z]` heading + root `package.json` bump (MINOR — new config + behavior) + compare-link; `pnpm check:release` green.

## 7. Out of scope

- The `yoom` `parse_error` (single-memory malformed model JSON) — separate issue.
- Cross-chunk dedup reconciliation — future spec.
- Changing the default grooming model (operational; handled via settings — fix A).

## 8. Acceptance

- 96-memory unscoped slice grooms to completion, 0 `llm_timeout`, across bounded calls.
- No memory beyond the previous truncation point is silently skipped.
- `pnpm --filter @librarian/core test`, `lint`, `typecheck`, `check:release` all green.

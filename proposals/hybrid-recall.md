# Proposal: Hybrid Recall for Durable Memories

## Status

Parked proposal for future implementation.

## Origin

This proposal came from reviewing EliasOulkadi/shokunin and comparing its ChromaDB/vector + BM25 recall approach with The Librarian's current deterministic memory search.

## Objective

Improve The Librarian's `recall` and `start_context` relevance by replacing simple token-inclusion scoring with a hybrid retrieval pipeline using SQLite FTS5 BM25, structured metadata boosts, recency/usefulness signals, and optional future vector similarity.

The aim is better recall for exact identifiers, commands, filenames, project-specific facts, and semantically related memories, while preserving The Librarian's governed memory model.

## Current State

The Librarian currently has:

- canonical JSONL event ledger,
- SQLite memory projection,
- FTS5 table,
- a simple deterministic token scorer,
- priority and project boosts,
- clean prose recall output.

This is dependency-light and predictable, but it will miss semantically related facts and can over-rank keyword coincidences.

## Proposed Behaviour

`recall` should combine multiple rankers:

1. **FTS ranker**
   - Use SQLite FTS5 `MATCH` and BM25 ranking.
   - Strong for exact terms, filenames, commands, rare identifiers, and proper nouns.

2. **Structured ranker**
   - Boost exact metadata matches:
     - `project_key`,
     - `category`,
     - `scope`,
     - `priority`,
     - `confidence`,
     - `usefulness_score`,
     - verified/recently used memories.

3. **Recency/usefulness ranker**
   - Boost recently verified-useful memories.
   - Penalise memories marked wrong, outdated, conflicted, rejected, archived, or deleted.

4. **Optional vector ranker**
   - Behind an interface only; not required for MVP.
   - JSONL remains canonical. Vector indexes are derived and rebuildable.

5. **Fusion**
   - Merge ranked lists using reciprocal rank fusion or similar.
   - Return clean prose exactly as normal agents expect.

## API Shape

Existing `recall` input remains compatible.

Optional future fields:

```json
{
  "agent_id": "bede",
  "query": "dashboard protected memory workflow",
  "categories": ["projects", "tools"],
  "project_key": "the-librarian",
  "include_private": true,
  "limit": 8,
  "from": "2026-05-01",
  "to": "2026-05-17",
  "rankers": ["fts", "structured", "recent"],
  "explain": false
}
```

`explain: true` should be debug/admin-only. Normal agents should receive clean prose, not ids and scoring internals.

## Data Model

No new canonical event types are required for MVP.

Possible projection additions:

- indexed `last_verified_at`,
- improved `usefulness_score`,
- precomputed rank signals,
- future vector index metadata.

## Boundaries

- JSONL remains the source of truth.
- SQLite, FTS, and vector indexes are rebuildable projections.
- Protected/private visibility filters must be applied before results are returned.
- Recall output remains clean prose by default.
- Do not add ChromaDB as a hard dependency unless benchmarks prove the need.

## Acceptance Criteria

- Existing tests continue passing.
- Existing `recall` output remains backwards-compatible.
- Exact command and filename queries rank correct memories highly.
- Project-specific memories outrank unrelated global memories.
- Wrong/outdated memories are penalised or excluded by default.
- `agent_private` memories do not leak between agents.
- A retrieval benchmark shows improvement over the baseline token scorer.

## Implementation Tasks

1. Add internal `searchMemoriesHybrid()` alongside the existing search path.
2. Implement `rankByFts()` using SQLite FTS5 BM25.
3. Implement `rankByStructuredSignals()`.
4. Implement recency/usefulness/staleness weighting.
5. Implement reciprocal rank fusion over memory ids.
6. Add tests for exact commands, filenames, project filtering, private isolation, and stale-memory penalties.
7. Add benchmark fixture with noisy memories.
8. Decide whether to replace or feature-flag the old scorer.

## Open Questions

- Should hybrid recall become default immediately or behind a feature flag?
- Should vector search be added only after benchmark evidence, or stubbed from day one?
- How much scoring explanation should admin/debug users be able to inspect?

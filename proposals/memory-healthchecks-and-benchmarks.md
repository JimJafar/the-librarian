# Proposal: Memory Healthchecks and Recall Benchmarks

## Status

Parked proposal for future implementation.

## Origin

This proposal came from reviewing Shokunin's `memory-healthcheck.sh`, `benchmark_memory.py`, and Chroma-related tests. The Librarian already has good behavioural tests, but it needs operational healthchecks and recall-quality benchmarks so memory regressions are visible.

## Objective

Add commands and fixtures that answer two questions:

1. Is The Librarian operationally healthy in this environment?
2. Is The Librarian retrieving the right memories under realistic noise?

Unit tests prove that functions behave. Healthchecks prove deployments are usable. Benchmarks prove recall quality has not silently degraded.

## Proposed Commands

```sh
npm run healthcheck
npm run benchmark:recall
npm run benchmark:sessions
```

Exact script names can change, but docs, package scripts, and tests must agree.

## Healthcheck Scope

The healthcheck should verify:

- data directory exists and is writable,
- JSONL append works,
- SQLite rebuild works,
- MCP stdio initialise/list-tools works,
- HTTP `/healthz` works when server is running,
- `/mcp` rejects unauthenticated requests when auth is enabled,
- agent token cannot use admin tools,
- admin token can approve a proposal,
- `start_context` returns approved identity/relationship context,
- unapproved protected proposals are excluded,
- `agent_private` memory does not leak,
- dashboard static files load,
- session lifecycle works once the session layer exists.

## Recall Benchmark Fixture

Seed a temporary data directory with controlled memories:

- exact command memory, e.g. `npm run alpha-deploy`,
- filename/path memory, e.g. `/home/jim/hermes-workspace/local-ai/foo.md`,
- UK English spelling preference,
- stale/wrong command memory,
- conflicting project-specific memories,
- identity/relationship protected proposals,
- noisy unrelated memories.

Measure:

- recall@1,
- recall@5,
- MRR,
- private leakage count,
- stale memory false-positive count,
- protected proposal leakage count,
- average latency.

## Session Benchmark Fixture

Once the session layer exists, seed sessions with:

- multiple active sessions,
- paused sessions with next steps,
- archived throwaway sessions,
- deleted sessions,
- same project across different harnesses,
- long-thread start/checkpoint/end boundaries.

Measure:

- correct ranking of active/same-project sessions,
- no auto-selection behaviour,
- archived/deleted exclusion by default,
- search result quality,
- handover package completeness.

## Output

Write machine-readable reports:

```text
benchmarks/results/latest.json
benchmarks/results/YYYY-MM-DDTHH-mm-ss.json
```

Example shape:

```json
{
  "timestamp": "2026-05-17T12:00:00Z",
  "suite": "recall",
  "strategy": "hybrid",
  "metrics": {
    "recall_at_1": 0.82,
    "recall_at_5": 0.97,
    "mrr": 0.88,
    "private_leaks": 0,
    "stale_false_positives": 0,
    "average_latency_ms": 14
  }
}
```

## Acceptance Criteria

- `npm run healthcheck` gives a clear pass/fail summary.
- Healthcheck failures include actionable diagnostics.
- Recall benchmark runs against an isolated temporary data directory.
- Benchmarks never expose real private memories or credentials.
- Private/protected leakage fails the benchmark.
- Stale/wrong memories surfacing by default fails the benchmark.
- Reports are written as JSON and optionally rendered as readable console tables.

## Implementation Tasks

1. Add `scripts/healthcheck.js`.
2. Add `benchmarks/recall-benchmark.js`.
3. Add isolated fixture builder using temporary data directories.
4. Add baseline scorer metrics.
5. Add hybrid scorer metrics once hybrid recall exists.
6. Add benchmark JSON report writer.
7. Add docs for interpreting benchmark results.
8. Add CI/local guidance for fast versus full benchmark runs.

## Open Questions

- Should healthcheck require a running HTTP server, or start one itself?
- Should benchmarks be part of CI or local-only initially?
- What minimum recall metrics should gate future changes?
- Should benchmark history be committed or ignored?

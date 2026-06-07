# ADR 0005 — Bounded grooming runs (configurable per-run memory cap)

- **Status:** Accepted
- **Date:** 2026-06-07
- **Context:** Live incident — every scheduled grooming run failing `llm_timeout`.

## Context

On a production instance, every recent scheduled grooming run failed with
`llm_timeout`. The decision log made the cause unambiguous:

| | input memories | duration | outcome |
|---|---|---|---|
| Completed runs | 1–13 | 3–60s | ✅ |
| Failed runs | 52–61 | 60s flat | ❌ `llm_timeout` |

The failures were all the same slice — the **`common` global slice** (no
project), which had grown to ~55–61 memories. The configured model
(`deepseek-v4-pro`, ~50–60 tok/s) needs ~150–200s to read that much
context and emit all the curation operations, but the per-consumer timeout
was 60s. The whole slice is sent in one prompt, so the request returned
zero tokens and aborted at 60s. Because a failed run doesn't advance the
slice's cursor, the identical oversized slice was reclaimed and re-run every
tick — a permanent failure loop. (Confirmed by the fix: after raising the
timeout to 240s the 61-memory slice completed in **171s / 10,464 output
tokens**, and 15 consecutive runs passed with 0 failures.)

The root cause is structural, not just a timeout that's too low: **nothing
bounds a grooming run to fit its timeout.** The evidence cap
(`curator-worker.ts` `DEFAULT_MAX_MEMORIES`) was a hardcoded 200 with no
setting to lower it, so a single slice can grow without limit until it
exceeds any fixed timeout. As the corpus grows, even a generous timeout is
a treadmill — 171s is already 71% of a 240s ceiling.

## Decision

Make the grooming per-run memory cap **configurable**, wired through the
tick so every run is bounded:

- New setting `curator.grooming.max_memories` (read in `readCuratorConfig`
  as `maxMemoriesPerRun`, settable via `writeCuratorConfig` / the
  `curator.setConfig` tRPC), validated to an integer in `[1, 1000]`.
- `runCuratorTick` passes it as `caps.maxMemories` into every run's evidence
  gather (`gatherMemoryEvidence`), so a slice larger than the cap is
  truncated rather than sent whole. An explicit `options.caps`
  (manual/maintenance, tests) still overrides it.
- **Default 200** — identical to the prior implicit cap, so existing installs
  are byte-for-byte unchanged. An operator on a slow model / large slice
  lowers it to keep runs inside the timeout.

The immediate live remediation was a separate, operator-side change: raise
`curator.grooming.timeout_ms` to 240000. That cleared the backlog. This ADR
is the durable code-side lever that complements it.

## Consequences

**Positive**

- An operator can now guarantee a grooming run fits its timeout regardless of
  corpus size, by setting the cap below what the model can process in the
  configured timeout.
- No behaviour change for existing installs (default preserves 200).

**Negative / trade-offs**

- **Coverage gap when the cap truncates.** Slice memories are selected
  `updated_at DESC` (`curator-source-vault.ts`), so a cap below the slice
  size feeds only the most-recently-updated N — the oldest memories are never
  groomed until their `updated_at` changes. This is an informed operator
  trade-off (a bounded, *completing* run over the freshest memories beats a
  run that always times out and grooms nothing), but it is a real gap.
- Setting it requires the tRPC/API today; a dashboard control is a follow-up.

## Follow-up (proposed, not in this ADR)

The cap bounds a run but doesn't *automatically* keep coverage. The next
increment is **automatic bounding with full coverage**, regardless of corpus
size — two candidate designs:

1. **Chunked runs** — when a slice exceeds the cap, process it as several
   sequential bounded LLM calls within the tick. Each call fits the timeout;
   the whole slice is covered every tick. Cost: cross-chunk dedup is missed
   within a tick, and more calls per tick.
2. **Rotating window** — select the N *least-recently-groomed* memories per
   run (derivable from the runs log's `input_memory_ids`, or a stamped
   `last_groomed_at`), so successive ticks cursor through the whole slice
   without stranding the tail.

Picking between these needs the maintainer's call on the dedup/coverage vs.
cost trade; this ADR ships the safe, operator-controlled cap first.

## Related

- ADR 0004 — `propose_memory` routes through the inbox (sibling curator work).
- Spec 044 — self-improving curator (the grooming tick this bounds).

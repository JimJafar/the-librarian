# Spec: Memory simplification

## Status

Draft for review, 2026-05-21.

## Objective

Make memory maintenance pleasant for agents. Concretely:

- `verify_memory` becomes load-bearing: `useful` / `not_useful` move recall rank, `outdated` archives.
- Collapse `archived` and `deleted` into a single hidden state — `archived`. One way to hide a memory, one ledger event type for it going forward.
- Rename the admin-only memory removal tool from `delete_memory` to `archive_memory` so the name matches the verb.
- Backfill the 82-memory cleanup so the agent's existing `outdated` verdicts take effect.

**Success means:** an agent who notices a duplicate or stale memory can call `verify_memory result=outdated` and trust that the memory drops out of subsequent recall — no admin involvement, no direct SQLite access, no separate archive tool to learn.

## Non-goals

- **Not changing the storage format.** `events.jsonl` and `sessions.jsonl` stay byte-compatible. Existing `memory.deleted` events stay in the ledger; the projection just maps them to `archived` going forward.
- **Not adding a restore-from-archive verb.** If you want an archived memory back, an admin can `update_memory` it with `status: active`. Add restore only if a real need surfaces.
- **Not adding a hard-purge tool.** Nothing removes data from the JSONL ledger. The ledger remains the immutable source of truth.
- **Not adding `consolidate_memories` as an atomic tool.** Consolidation is `update_memory` (merge content into canonical) + `verify_memory result=outdated` (on the duplicates). The manual two-step is fine until usage proves otherwise.
- **Not changing the protected-categories workflow.** `proposed` / `conflicted` / `rejected` statuses stay; they're orthogonal to the active/archived dichotomy.

## Decisions (resolved)

- **`verify_memory` becomes the single agent-callable verb for usefulness and archival.** No separate `archive_memory` for agents. Outcomes:
  - `useful` → `usefulness_score += 1`, clamped to `≤ +3`. Status unchanged.
  - `not_useful` → `usefulness_score -= 1`, clamped to `≥ -3`. Status unchanged.
  - `outdated` → status → `archived`. `usefulness_score` unchanged.
- **Starting `usefulness_score: 0`** for every new memory. (Already the default in the schema; no change.)
- **No auto-archive on low score.** `useful` / `not_useful` are contextual verdicts about a recall, not durable judgements about the memory. Only `outdated` archives. Past the clamp bounds, additional verdicts are no-ops on ranking but still appended to `events.jsonl` so the verification history is intact.
- **Recall scoring change is additive and minimal.** New formula:
  ```
  score = text_match + priority_bonus + project_match + clamp(usefulness_score, -3, +3)
  ```
  Same magnitude range as the existing scoring bands (`priority=core` = +3, project match = +3), so a maxed-out `usefulness_score` lets a "normal" memory compete with a `core` one.
- **Collapse `deleted` into `archived`.** Remove `MemoryStatus.Deleted` from the enum. `MemoryEventType.Deleted` stays as a historical event-type variant in the projection so old ledger lines still parse; the projection maps `memory.deleted` events to `status: archived`.
- **Rename the admin removal tool: `delete_memory` → `archive_memory` (admin-only).** Sets `status: archived`, appends `memory.archived` event. Tool description updated to match. Pre-1.0; integration packages don't hardcode this name.
- **Backfill the 82-memory cleanup as a one-shot script.** `scripts/replay-verify-outcomes.mjs` replays `events.jsonl`, finds the most recent verify event per memory, and applies the new semantics: archive on last-verdict-was-outdated, increment/decrement (clamped) usefulness_score for useful/not_useful events. Idempotent. Operator runs it once on the canonical instance; the projection rebuild picks up the changes on next mcp-server restart.

## Tech stack

No new dependencies. All changes inside `@librarian/core` (schemas, store, projection), `@librarian/mcp-server` (tool descriptions), `apps/dashboard` (memory list shows usefulness, archive tab unchanged), and one new script under `scripts/`.

## Migration plan (phases)

Each phase is one PR. Each phase leaves `main` releasable. Phases land serially.

### Phase 1 — Live `verify_memory` + scoring (V1.1)

Make verify outcomes do what they say.

- `verifyMemory` in `@librarian/core` updates `usefulness_score` (clamped ±3) for `useful` / `not_useful` and sets `status: archived` for `outdated`. Append the same `memory.verified` event as today, plus an additional `memory.archived` event when outdated triggers archival.
- The projection's `memory.verified` handler applies the score change. The `memory.archived` handler already exists.
- Recall scoring in `memory-store.ts` includes `clamp(usefulness_score, -3, +3)` in the final score sum.
- Dashboard memory list shows `usefulness_score` as a small column (`+2`, `-1`, `0`). No new dashboard write actions yet.
- Tests:
  - Unit: `verifyMemory(useful)` increments score; `verifyMemory(not_useful)` decrements; both clamp at ±3 (5× useful still results in score=3); `outdated` archives + memory stops appearing in default recall.
  - Projection: a fresh rebuild from JSONL produces correct `usefulness_score` values.
  - Recall: a memory with `usefulness_score: 3` outranks an otherwise-identical memory with `usefulness_score: 0` for the same query.
- **Acceptance:** `verify_memory` events change the projection; recall sort respects usefulness; archived memories drop out of default recall.

### Phase 2 — Collapse `deleted` → `archived` + rename `delete_memory` → `archive_memory` (V1.2)

State collapse and tool rename land together — both are name-and-shape changes touching the same surface.

State collapse:

- Remove `MemoryStatus.Deleted` from `packages/core/src/schemas/common.ts`.
- Update the projection: `case MemoryEventType.Deleted` sets `status: archived` (was `deleted`) and clears `deleted_at`. `MemoryEventType.Deleted` stays as a historical event-type literal in the discriminated union so old ledger lines parse — but no new code emits it.
- Update store callsites that referenced `MemoryStatus.Deleted` (filters, list queries, dashboard tabs) to treat it as `archived`.
- Dashboard: drop the separate `deleted` filter from the memory list / archive tab; `archived` is the only hidden state.
- Storage fixture (`scripts/check-storage-fixture.mjs`) updated to reflect the collapsed projection. Fixture file regenerated with one rebuild round.
- Schema-version sentinel (`scripts/check-schema-version.mjs`) bumped — the projection shape changed enough that the rebuild guard should re-verify.

Tool rename:

- Rename `packages/mcp-server/src/mcp/tools/delete-memory.ts` → `archive-memory.ts`. Update the tool name + description. Behavior: admin-only, sets `status: archived`, appends `memory.archived` event (not `memory.deleted` anymore — emitting `archived` directly is cleaner now that the two events project to the same status).
- Update `tools/index.ts` registry. The MCP `tools/list` response no longer includes `delete_memory`.
- Update integration docs (`integrations/*/AGENTS.md`, `skills/use-the-librarian/SKILL.md`) where they reference `delete_memory`.
- Update README MCP tools list.
- Update the tRPC equivalent in `packages/mcp-server/src/trpc/memories.ts`: rename `delete` procedure to `archive`. The dashboard's "Delete memory" admin action becomes "Archive memory" — wording change in the LifecycleActions surface.

Tests:

- Replay a fixture containing `memory.deleted` events; assert the rebuilt projection has those memories with `status: archived`, not `deleted`.
- Existing tests that asserted `status === "deleted"` change to `status === "archived"`.
- MCP integration test: `archive_memory` produces a `memory.archived` event and sets `status: archived`.
- tRPC test: `memories.archive` procedure round-trips.
- Remove the obsolete `delete_memory` MCP test, or convert it to verify the tool is no longer in `tools/list`.

**Acceptance:** zero references to `MemoryStatus.Deleted` in production source; `tools/list` shows `archive_memory`, not `delete_memory`; dashboard admin action is "Archive"; storage-fixture + schema-version guards green; rebuild from existing canonical-instance ledger doesn't break (verified locally against a copy of canonical's `events.jsonl`).

### Phase 3 — Backfill script for 82-memory cleanup (V1.3)

Apply the new semantics to existing verify history.

- New script: `scripts/replay-verify-outcomes.mjs`. Behavior:
  - Reads `LIBRARIAN_DATA_DIR` (or `--data-dir`).
  - Streams `events.jsonl`, tracking the most recent `memory.verified` event per `memory_id`.
  - For each memory whose last verify outcome was `outdated`: emit a `memory.archived` event (idempotent — skip if the memory is already archived).
  - For each memory whose last verify outcome was `useful` / `not_useful`: emit a `memory.usefulness_adjusted` event (new event type — see below) with the clamped delta vs. the current score.
  - Dry-run mode by default; `--apply` writes the events.
  - Logs a summary: `X archived, Y score-adjusted, Z untouched`.
- New event type `MemoryEventType.UsefulnessAdjusted` (variant of the memory ledger discriminated union, payload `{ memory_id, agent_id, score_delta, source: "backfill" }`). The projection adds it to `usefulness_score` with the clamp. This keeps the backfill auditable in the ledger rather than mutating SQLite directly.
- Storage-fixture guard updated to include a `UsefulnessAdjusted` example so the projection handler stays covered.
- Tests:
  - Replay a synthetic ledger with 3 memories, each with a different last-verify outcome; assert the script archives the outdated one, score-adjusts the others.
  - `--apply` is idempotent: running it twice produces the same projection state and one set of backfill events (second run finds nothing to do).
- **Acceptance:** dry-run against a copy of canonical's ledger reports a sensible plan (the 82 outdated memories show up in the archive count). `--apply` against a local copy converts them. Re-running is a no-op.

### Phase 4 — Docs polish (V1.4)

Update the writing.

- README "MCP Tools" → memory tools section reflects `verify_memory`'s new semantics + the `archive_memory` rename. Drop `delete_memory`.
- `skills/use-the-librarian/SKILL.md` — the agent-facing guidance — clarifies the new `verify` semantics and the absence of a separate archive verb.
- `specs/memory-simplification.md` (this file) status → "Implemented YYYY-MM-DD".
- `TODO.md`: items #15–#17 (dashboard) stay; this spec doesn't address them. Maintenance-cleanup follow-ups (#10 physical purge) explicitly noted as still deferred.
- **Acceptance:** stranger walkthrough — read the README's memory section, can you describe what each verify outcome does in one sentence?

## Summary

| Phase | PR | What |
|---|---|---|
| 1 | V1.1 | Live `verify_memory` + recall scoring |
| 2 | V1.2 | Collapse `deleted` → `archived` + rename `delete_memory` → `archive_memory` |
| 3 | V1.3 | 82-memory backfill script |
| 4 | V1.4 | Docs polish |

4 PRs, serial. Each leaves `main` releasable.

## Open questions

None at draft time.

## Acceptance review (for this spec)

- Does `verify result=outdated` archive feel like the right model, or should archive remain a separate verb? — Decided: collapsed.
- Should `usefulness_score` decay over time? — Not in v1. Revisit if score inflation becomes a real issue.
- Should the backfill emit a single `memory.usefulness_adjusted` per affected memory (delta = clamped target - current) or replay each individual verify event? — Single delta. The original verify events stay in the ledger; one synthesized adjustment per memory keeps the backfill auditable without duplicating history.

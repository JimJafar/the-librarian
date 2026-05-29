# Spec: Memory simplification

## Status

Implemented 2026-05-21 (V1.1 in PR #45, V1.2 in PR #46, V1.3 in PR #47, V1.4 in this PR).

## Objective

Make memory maintenance pleasant for agents and cut the state model down to what's actually load-bearing. Concretely:

- `verify_memory` becomes load-bearing: `useful` / `not_useful` move recall rank, `outdated` archives.
- Collapse the six memory statuses (`active`, `proposed`, `conflicted`, `archived`, `deleted`, `rejected`) down to three: `active`, `proposed`, `archived`. The *reason* a memory is archived (outdated / rejected / superseded / explicit) lives in the events ledger, not the enum.
- Rename the admin-only memory removal tool from `delete_memory` to `archive_memory` so the name matches the verb.
- Delete the dead conflict-detection machinery: the `seemsConflict` keyword heuristic in `createMemory`, the `MemoryStatus.Conflicted` projection branch (never reachable for new memories — the candidate isn't in the projection at conflict time), the `resolve_conflict` MCP tool, and the dashboard `/conflicts` tab.
- Backfill the 82-memory cleanup so the agent's existing `outdated` verdicts take effect.

**Success means:** an agent who notices a duplicate or stale memory can call `verify_memory result=outdated` and trust that the memory drops out of subsequent recall — no admin involvement, no direct SQLite access, no separate archive tool to learn. Saving a new memory always succeeds — `createMemory` returns `duplicates: Memory[]` as informational signal but never refuses the write.

## Non-goals

- **Not changing the storage format.** `events.jsonl` and `sessions.jsonl` stay byte-compatible. Existing `memory.deleted` / `memory.rejected` / `memory.conflict_detected` / `memory.conflict_resolved` events stay in the ledger; the projection maps them to the new state model.
- **Not adding a restore-from-archive verb.** If you want an archived memory back, an admin can `update_memory` it with `status: active`. Add restore only if a real need surfaces.
- **Not adding a hard-purge tool.** Nothing removes data from the JSONL ledger. The ledger remains the immutable source of truth.
- **Not adding `consolidate_memories` as an atomic tool.** Consolidation is `update_memory` (merge content into canonical) + `verify_memory result=outdated` (on the duplicates). The manual two-step is fine until usage proves otherwise.
- **Not changing the protected-categories workflow.** `proposed` status, `propose_memory`, and `approve_proposal` stay. Identity and relationship categories continue to require admin approval before becoming active.
- **Not designing a replacement conflict-detection UX.** The current detector is too lossy to keep, but a deliberate replacement (e.g. surface near-duplicates at recall time) is its own design problem. Out of scope here.

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
- **Collapse `deleted`, `rejected`, and `conflicted` into `archived`.** Remove all three from `MemoryStatus`. The corresponding event-type variants (`memory.deleted`, `memory.rejected`, `memory.conflict_detected`, `memory.conflict_resolved`) stay in the projection so old ledger lines parse; the handlers all set `status: archived` (or no-op for `conflict_detected`, which historically never resolved to a saved row). After this:
  ```
  MemoryStatus = active | proposed | archived
  ```
- **Rename the admin removal tool: `delete_memory` → `archive_memory` (admin-only).** Sets `status: archived`, appends `memory.archived` event. Tool description updated to match. Pre-1.0; integration packages don't hardcode this name.
- **Delete the conflict-detection machinery.** Drop the `seemsConflict` function in `memory-store.ts`. `createMemory` no longer takes a `conflicts` branch — every call saves and returns `{ status, memory, duplicates }`. The `duplicates` field (ratio ≥ 0.55 via `detectRelated`, which uses real token-overlap not the keyword heuristic) is retained as informational signal so an agent can decide whether to consolidate manually. Drop the `resolve_conflict` MCP tool, its tRPC procedure, and the dashboard `/conflicts` route (which queries `status: "conflicted"` and would always return zero rows under the new model anyway).
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

### Phase 2 — State collapse + propose/conflict cleanup (V1.2)

The biggest PR in the sequence. Collapses three redundant statuses, renames the admin tool, and deletes the dead conflict machinery. All of it touches the same files (memory enum, store, projection, MCP tools registry, tRPC router, dashboard memory pages) so landing it together avoids two intermediate states where the code is half-migrated.

**State collapse (`deleted`, `rejected`, `conflicted` → `archived`):**

- Remove `MemoryStatus.Deleted`, `MemoryStatus.Rejected`, `MemoryStatus.Conflicted` from `packages/core/src/schemas/common.ts`. After this, `MemoryStatus = active | proposed | archived`.
- Update the projection (`packages/core/src/store/projection.ts`):
  - `MemoryEventType.Deleted` → sets `status: archived` (was `deleted`); clear `deleted_at`.
  - `MemoryEventType.Rejected` → sets `status: archived` (was `rejected`).
  - `MemoryEventType.ConflictDetected` → no-op on status (event is still appended, but no status mutation; the historical branch was unreachable for new memories and harmful when the candidate eventually was saved).
  - `MemoryEventType.ConflictResolved` → for `resolution: "archive" | "supersede"` (non-canonical id), set `status: archived`; for `keep_both` / canonical id, set `status: active`. Same behaviour as today, just without the dead `conflicted` intermediate.
- The event-type variants stay in the discriminated union so old ledger lines parse — they just project to the new state model. No new code emits `memory.deleted`, `memory.rejected`, `memory.conflict_detected`, or `memory.conflict_resolved`.
- Update store callsites and dashboard pages that filtered on the removed statuses; they all collapse to `archived`.
- Storage fixture (`scripts/check-storage-fixture.mjs`) regenerated with one rebuild round.
- Schema-version sentinel (`scripts/check-schema-version.mjs`) bumped.

**Tool rename:**

- Rename `packages/mcp-server/src/mcp/tools/delete-memory.ts` → `archive-memory.ts`. Admin-only; sets `status: archived`, appends `memory.archived` event (not `memory.deleted` — emitting the new event type directly is cleaner now).
- Update `tools/index.ts` registry. The MCP `tools/list` response no longer includes `delete_memory`.
- tRPC: rename `memories.delete` procedure to `memories.archive` in `packages/mcp-server/src/trpc/memories.ts`. Dashboard's "Delete memory" admin action becomes "Archive memory".

**Conflict cleanup:**

- Delete the `seemsConflict` function in `memory-store.ts`.
- Update `createMemory`: drop the `related.conflicts.length && !options.allowConflict` branch and the `{status: "conflict", ...}` return. Every call saves. The return shape becomes:
  ```ts
  { status: "active" | "proposed"; memory: Memory; duplicates: Memory[] }
  ```
  `duplicates` (from `detectRelated`, ratio ≥ 0.55, real token overlap) is kept as informational signal.
- Delete `detectRelated`'s `conflicts` calculation. It only feeds the now-dead branch and the per-call `seemsConflict` invocation. Keep the `duplicates` calculation.
- Delete the `resolveConflict` store method and its `MemoryEventType.ConflictResolved` emission path. The event-type variant stays in the projection handler for historical replay; no new code emits it.
- Delete the `resolve_conflict` MCP tool (`packages/mcp-server/src/mcp/tools/resolve-conflict.ts`) and remove from the registry.
- Delete the `memories.resolve` tRPC procedure (if present) — check during implementation.
- Delete the dashboard `/conflicts` route (`apps/dashboard/app/(memories)/conflicts/page.tsx`) and remove the tab from the memories nav.
- The `allowConflict` option on `createMemory` becomes dead — drop it from the signature.

**Integration docs:**

- Update `skills/use-the-librarian/SKILL.md` to describe the new three-state model and drop references to conflict resolution.
- Update README MCP tools list: drop `delete_memory` + `resolve_conflict`, add `archive_memory`.

**Tests:**

- Projection: replay a fixture with `memory.deleted`, `memory.rejected`, `memory.conflict_resolved` events; assert all rebuild to `status: archived` (or `active` for `keep_both`).
- `createMemory` no longer returns `{status: "conflict"}` for any input. Test removes the existing assertion that conflict input is refused.
- MCP integration test: `archive_memory` produces `memory.archived` and sets `status: archived`. `resolve_conflict` is no longer in `tools/list`.
- tRPC test: `memories.archive` round-trips. `memories.resolve` is gone.
- Dashboard: `/conflicts` route 404s; conflicts tab not rendered.

**Acceptance:** zero references to `MemoryStatus.Deleted | Rejected | Conflicted` in production source; zero references to `seemsConflict` or `resolveConflict`; `tools/list` shows `archive_memory` and not `delete_memory` / `resolve_conflict`; dashboard memories nav has no conflicts tab; storage-fixture + schema-version guards green; rebuild from existing canonical-instance ledger doesn't break.

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

- README "MCP Tools" → memory tools section reflects `verify_memory`'s new semantics + the `archive_memory` rename. Drop `delete_memory` and `resolve_conflict`. Document the three-state model (`active` / `proposed` / `archived`) explicitly so the absence of `conflicted` doesn't come as a surprise to anyone reading old PRs.
- `skills/use-the-librarian/SKILL.md` — the agent-facing guidance — clarifies the new `verify` semantics, the absence of a separate archive verb, and that `createMemory` always saves (returning `duplicates` for informational use).
- `specs/005-memory-simplification.md` (this file) status → "Implemented YYYY-MM-DD".
- `TODO.md`: items #15–#17 (dashboard) stay; this spec doesn't address them. Maintenance-cleanup follow-ups (#10 physical purge) explicitly noted as still deferred.
- **Acceptance:** stranger walkthrough — read the README's memory section, can you describe what each verify outcome does in one sentence?

## Summary

| Phase | PR | What |
|---|---|---|
| 1 | V1.1 | Live `verify_memory` + recall scoring |
| 2 | V1.2 | State collapse (`deleted` / `rejected` / `conflicted` → `archived`) + `delete_memory` rename + delete conflict machinery |
| 3 | V1.3 | 82-memory backfill script |
| 4 | V1.4 | Docs polish |

4 PRs, serial. Each leaves `main` releasable.

## Open questions

None at draft time.

## Acceptance review (for this spec)

- Does `verify result=outdated` archive feel like the right model, or should archive remain a separate verb? — Decided: collapsed.
- Should `usefulness_score` decay over time? — Not in v1. Revisit if score inflation becomes a real issue.
- Should the backfill emit a single `memory.usefulness_adjusted` per affected memory (delta = clamped target - current) or replay each individual verify event? — Single delta. The original verify events stay in the ledger; one synthesized adjustment per memory keeps the backfill auditable without duplicating history.

# Spec: Session storage rearchitecture

## Status

Implemented 2026-05-21. Four serial PRs landed:

- R1 (PR #64) — `sessions.state_version` + `session_state_changes` audit table.
- R2 (PR #65) — migration script + CI divergence guard + operator runbook.
- R3 (PR #66) — runtime cutover to SQLite-canonical sessions + `purge_session` admin tool.
- R4 (this PR) — docs polish (README backup section + TODO #13 closed) + spec close-out.

Resolves TODO #13.

## Objective

Replace the current JSONL-canonical / SQLite-projection model for **sessions** with a hybrid: **mutable `sessions` row in SQLite as the authoritative state**, plus an **append-only `session_events.jsonl` for genuine timeline events only** (notes, decisions, attaches, handovers, agent-recorded command / file / error / question / attachment records).

The session-simplification spec (S1.x) explicitly named this as a future spec and called out the trigger. Drafting now ahead of the trigger because (a) migration cost grows with ledger volume, (b) the auto-checkpoint hook ideas in TODO #12 would multiply session-write rates before the model is fixed, and (c) the conceptual mismatch is already paying compounding interest in cognitive overhead every time a contributor reads the session-store code.

**Memories are not touched.** The JSONL-canonical model fits memories well — they plateau in volume, every event is a genuine state-changing fact, and the projection rebuild cost stays bounded. This spec breaks the symmetry between memory and session storage deliberately, accepting that two paradigms is the cost of using the right tool for each.

**Success means:**

- Session state (status, rolling_summary, last_activity_at, etc.) lives in SQLite as a mutable row, updated in place.
- `session_events.jsonl` contains only timeline events — notes, decisions, handovers, attach records, and the agent-recorded payload events (commands, files touched, errors, questions, attachments). State transitions are no longer ledger lines.
- A `purge_session` admin path exists: deletes the SQLite row + its events from `session_events.jsonl` (rewrite). The system finally has a hard-delete story.
- Cold rebuild from `session_events.jsonl` alone can reconstruct *event history*, but session current state is authoritative in SQLite — backup story now requires both `events.jsonl` (memories), `session_events.jsonl` (session timeline), *and* `librarian.sqlite` (sessions authoritative + memory projection).
- Write rate for a typical checkpoint-heavy session drops from O(N) JSONL lines to O(1) SQLite update + 0 or 1 timeline-event JSONL lines.

## Non-goals

- **Not changing the memory storage architecture.** JSONL-canonical stays for memories.
- **Not changing the session API surface.** `start_session`, `pause_session`, `end_session`, `continue_session`, `attach_session`, `checkpoint_session`, `list_sessions`, `search_sessions`, `get_session`, `list_session_events`, `record_session_event`, `promote_session_fact` keep their inputs and outputs. Internally they switch storage backends.
- **Not changing the session state model.** Three states (`active | paused | ended`) from S1.1 stay.
- **Not designing the dashboard surface for purge.** The `purge_session` MCP tool ships; the dashboard's "Purge" button + confirmation flow is a separate dashboard PR after this rearchitecture lands.
- **Not designing a session retention policy.** TODO #10 (physical purge with retention) is the *use case* for `purge_session`; the policy (auto-purge after N days, etc.) is out of scope here. Manual purge only.
- **Not redesigning the rolling-summary content.** What gets stored in `rolling_summary` is unchanged.

## Decisions (resolved)

- **SQLite is authoritative for current session state.** The `sessions` row carries the full picture: `session_id`, `status`, `rolling_summary`, all timestamps, all the projection fields that exist today, plus a new `state_version` integer that increments on every state transition (used for optimistic-locking-style guards in `R3`).
- **`session_events.jsonl` (new file) carries only timeline events.** Specifically:
  - `session.note` (agent-recorded narrative)
  - `session.decision` (explicit decisions)
  - `session.attached` (cross-harness handoff)
  - `session.command_run` (agent-recorded command)
  - `session.file_touched` (agent-recorded file edit)
  - `session.error` (agent-recorded error / failed step)
  - `session.question` (agent-recorded open question)
  - `session.attachment` (agent-recorded artifact link)
  - `session.fact_promoted` (memory promoted from a session fact — the audit anchor for the cross-link)
- **State transition events are removed from the JSONL ledger entirely.** The retired event types:
  - `session.started` — replaced by SQLite row creation
  - `session.checkpointed` — replaced by SQLite `rolling_summary` + `last_checkpoint_at` update
  - `session.paused` — replaced by SQLite `status` flip + `paused_at` update
  - `session.resumed` — replaced by SQLite `status` flip + `resumed_at` update
  - `session.ended` — replaced by SQLite `status` flip + `ended_at` + optional `end_summary` update
- **An auxiliary `session_state_changes` table in SQLite preserves the transition audit trail.** Columns: `id`, `session_id`, `from_status`, `to_status`, `actor_agent_id`, `at`, `note`. Append-only within SQLite. Cheap to write, queryable, and the dashboard's "Activity" timeline reads this *plus* the `session_events.jsonl` timeline merged by timestamp. Backup story: covered by the SQLite backup; not duplicated to JSONL.
- **The old `sessions.jsonl` is preserved (read-only) post-migration.** Renamed to `sessions.legacy.jsonl` and kept on disk. R2 (migration) reads it once; from R3 onward nothing writes to or reads from it during normal operation. It's a cold-storage audit anchor.
- **Dual-write phase (R1) is the safety net.** R1 writes state transitions to *both* SQLite and the legacy `sessions.jsonl` so we can verify the SQLite write is correct against the JSONL replay before cutting over. R3 drops the JSONL writes.
- **Cold-rebuild story is reframed.** `pnpm run rebuild` for sessions becomes: "from `session_events.jsonl`, rebuild the timeline view; from the SQLite snapshot, restore current state". If SQLite is destroyed without backup, sessions current state is *lost* — only the timeline events can be replayed, and only into a degraded "every session is in some unknown state with these notes" view. This is the cost of the new model and is documented loudly.
- **Backup docs change.** README's backup section is rewritten: `data/events.jsonl` + `data/session_events.jsonl` + `data/librarian.sqlite` are *all* now critical. Pre-rearchitecture, SQLite was rebuildable; post-rearchitecture it's authoritative for sessions and must be backed up.
- **No event-type aliasing for the retired transitions.** Unlike S1.1 (which kept `SessionStatus.Archived` parsing for legacy lines), R1 doesn't add new code paths for the retired event types — they're handled exactly once by R2 (the migration script) and then never spoken of in code again. The legacy file is the only place they exist.
- **`PROJECTION_SCHEMA_VERSION` bump per phase.** R1 = 5, R3 = 6, R4 = 7. Each forces a one-time projection rebuild on the canonical instance after deployment.

## Tech stack

- **`better-sqlite3`** — already in use; the new table + transition table are vanilla migrations under `packages/core/src/store/migrations/`.
- **No new packages.** All the moving parts are internal store + projection refactors.
- **Migration script** is a Node ESM file under `scripts/` consistent with the existing `replay-verify-outcomes.mjs` / `check-storage-fixture.mjs` shape.
- **Backup tooling** — out of scope here, but the new docs reference standard `cp` / `rsync` patterns; if a future spec wants a `dump_data.sh` admin script, that's where it lives.

## Architecture (the shape after R4)

```
data/
├── events.jsonl                # memories — canonical, unchanged
├── memories.md                 # memories — rendered, regenerable
├── session_events.jsonl        # sessions — timeline events only (NEW name + scope)
├── sessions.legacy.jsonl       # sessions — pre-migration archive, read-only
└── librarian.sqlite            # AUTHORITATIVE for session state; projection for memories

packages/core/src/store/
├── memory-store.ts             # unchanged shape — appends to events.jsonl, reads from SQLite
├── session-store.ts            # new shape — writes directly to SQLite for state,
│                               #   appends to session_events.jsonl for timeline events
├── projection.ts               # memory projection handlers unchanged;
│                               #   session "projection" reads from authoritative SQLite,
│                               #   session_events replay is for timeline view only
└── migrations/
    ├── 001-initial.sql         # existing
    ├── 002-fts.sql             # existing
    ├── 003-sessions-authoritative.sql       # NEW (R1) — adds state_version column,
    │                                        #   session_state_changes table
    └── 004-drop-vestigial.sql              # NEW (R4) — drops any columns superseded
                                            #   by the migration (e.g., prior_status)
```

## Migration plan (phases)

Each phase is one PR. Each phase leaves `main` releasable. Phases land serially.

### Phase 1 — Dual-write + authoritative schema (R1)

Adds the new architecture *alongside* the existing one. Every state transition writes to both SQLite (authoritative) and the legacy `sessions.jsonl` (verification). Reads of session state go from the existing projection (unchanged), which is also kept in sync because the projection re-runs over the JSONL writes during dual-write.

**Schema:**

- New migration `003-sessions-authoritative.sql`:
  - Add `state_version INTEGER NOT NULL DEFAULT 0` to `sessions`.
  - Add `last_checkpoint_at`, `paused_at`, `resumed_at`, `ended_at` as explicit columns (some may already exist as nullable).
  - Create `session_state_changes` table: `id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL, actor_agent_id TEXT, at TIMESTAMP NOT NULL, note TEXT, FOREIGN KEY (session_id) REFERENCES sessions(session_id)`.
- `PROJECTION_SCHEMA_VERSION` bumped to 5.

**Session store (`packages/core/src/store/session-store.ts`):**

- New private `writeStateTransition(session_id, from_status, to_status, opts)` helper that:
  1. Begins a SQLite transaction.
  2. Updates the `sessions` row: status, relevant timestamp column, increment `state_version`.
  3. Inserts a `session_state_changes` row.
  4. Commits.
- `startSession`, `pauseSession`, `endSession`, `continueSession`, `attachSession`, `checkpointSession` all call `writeStateTransition` (or the inline equivalent for `start`).
- **Dual-write:** the existing JSONL-emit code stays. After the SQLite write succeeds, the same logical event is appended to `sessions.jsonl` as today. The two writes are NOT in a shared transaction (SQLite + filesystem appends can't be); instead, the SQLite write is the success criterion and the JSONL append is a best-effort audit anchor. A failed JSONL append logs a warning and continues — R2 (verification) will catch any divergence.
- The projection still runs over `sessions.jsonl` lines on rebuild, so the existing `pnpm run rebuild` path continues to work.

**Reads:**

- No change. `getSession`, `listSessions`, `searchSessions` still read the projection (which is now updated by both the SQLite-direct write and the JSONL replay; they converge).

**Tests (R1):**

- Unit: every state-transition method writes the expected `sessions` row update + `session_state_changes` row + JSONL line.
- Integration: a transaction that fails mid-way doesn't leave `state_version` advanced without the corresponding `session_state_changes` row.
- Storage fixture: replay against the new schema produces the same `sessions` row state as direct writes.
- Property test: after N random state transitions on a session, the SQLite state matches the JSONL-replay state. (This is the dual-write equivalence check; R2 makes it a hard guard.)

**Acceptance (R1):**

- New SQLite schema present; `state_version` increments on every transition.
- Dual-write produces matching state in SQLite and the JSONL-replay projection.
- All existing session tests pass.
- `pnpm run check:storage-fixture` passes against the bumped schema.

### Phase 2 — Migration script + dual-read verification (R2)

The one-time conversion + a hard guard that catches any divergence between SQLite-authoritative and JSONL-replay states.

**Migration script (`scripts/migrate-sessions-to-authoritative-sqlite.mjs`):**

- Reads `data/sessions.jsonl` line-by-line.
- For each session:
  - Replays the full event sequence to compute the final state (same logic as the projection).
  - Writes the final state to the `sessions` SQLite row (idempotent — re-running over an already-migrated session is a no-op).
  - Writes one `session_state_changes` row per historical transition.
- For each event line:
  - If it's a timeline event (`note`, `decision`, `attached`, etc.), copies it to the new `session_events.jsonl`.
  - If it's a state-transition event, ignores it (already captured in `session_state_changes`).
- Renames `sessions.jsonl` → `sessions.legacy.jsonl`.
- Writes a summary report: rows migrated, timeline events copied, state changes recorded, transitions skipped.
- Runs as `pnpm run migrate:sessions-to-sqlite-canonical`.

**Verification guard:**

- New `scripts/check-session-state-divergence.mjs` runs in CI (added to the build job):
  - Walks every session in SQLite.
  - For each one, replays the timeline events from `session_events.jsonl` + the `session_state_changes` table.
  - Asserts the SQLite `sessions` row matches the replayed state.
- This is the formal equivalent of R1's property test, now part of CI.
- Pre-migration: the check is a no-op (the new `session_events.jsonl` doesn't exist yet). Post-migration: it's load-bearing.

**Operator runbook:**

- New `docs/migration-sessions-storage.md` with the runbook:
  1. Backup current `data/` directory in full.
  2. Stop the MCP server.
  3. Run `pnpm run migrate:sessions-to-sqlite-canonical`.
  4. Review the summary report — row count should equal the live session count + ended sessions.
  5. Start the MCP server. R1's dual-write means the system still works exactly as before.
  6. Verify a `getSession` call against a known session returns the expected state.
  7. Verify `list_sessions` defaults match pre-migration counts.

**Tests (R2):**

- Migration script: takes a fixture `sessions.jsonl` with all event types, produces the expected SQLite state + timeline JSONL + skipped count.
- Divergence check: deliberately mutate the SQLite row out from under the timeline; assert the check fails loudly.
- Idempotency: run the migration twice; second run reports zero changes.

**Acceptance (R2):**

- Migration runs cleanly against the canonical instance's `sessions.jsonl`.
- `session_events.jsonl` exists and contains only timeline event types.
- `sessions.legacy.jsonl` is the original file, renamed.
- CI divergence check passes.
- Operator runbook validated against the canonical instance (item #2 in the follow-ups list).

### Phase 3 — Single-write path (R3)

Cuts the JSONL dual-write. SQLite is the only place state transitions are recorded; timeline events are the only thing written to `session_events.jsonl`.

**Session store:**

- Remove the JSONL-emit code for state-transition events (`session.started`, `session.checkpointed`, `session.paused`, `session.resumed`, `session.ended`).
- `recordSessionEvent` continues to append to `session_events.jsonl` for the timeline event types listed in Decisions.
- The projection's session handlers for state-transition event types are removed (or left as no-op tombstones that warn if invoked, on the off chance a legacy line slips through).

**Rebuild path:**

- `pnpm run rebuild` for sessions becomes:
  - Read the SQLite snapshot (it's the source of truth).
  - Replay `session_events.jsonl` to rebuild any timeline-derived columns (e.g., a `last_note_at` if we expose one).
  - The session_state_changes table is part of the SQLite snapshot, so the activity timeline survives.
- The memory rebuild path is unchanged.
- `pnpm run rebuild --sessions-only` flag added for partial rebuilds.

**New tool: `purge_session`:**

- MCP tool: input `{ session_id: string, confirm: true }`. Requires admin token.
- Behaviour:
  1. Verify session exists and is in `ended` status (refuse purge of active / paused).
  2. Delete the SQLite `sessions` row + the related `session_state_changes` rows.
  3. Rewrite `session_events.jsonl` excluding lines for the purged `session_id`. (Append-only is broken here on purpose — this is the deliberate purge path.)
  4. Return `{ purged: true, events_removed: N, state_changes_removed: M }`.
- tRPC procedure: `sessions.purge`. Same input + admin gating.
- Dashboard: NOT included in this PR — the surface is a separate dashboard PR. The MCP tool + tRPC procedure are the durable interface.

**Schema:**

- `PROJECTION_SCHEMA_VERSION` bumped to 6.

**Backup docs:**

- README backup section rewritten:
  > Back up `data/events.jsonl`, `data/session_events.jsonl`, and `data/librarian.sqlite`. All three are critical: the first two are append-only logs (memories and session timeline), the third is the authoritative source for session current state. `data/memories.md` and the projection columns of `librarian.sqlite` for memories are rebuildable via `pnpm run rebuild` from the JSONL logs, but session state itself is not — losing `librarian.sqlite` without backup means losing every session's `status`, `rolling_summary`, and timestamps.
- `data/sessions.legacy.jsonl` is mentioned as "historical, optional backup".

**Tests (R3):**

- No state-transition events appear in `session_events.jsonl` post-R3.
- `purge_session` removes the SQLite row, `session_state_changes` rows, and JSONL lines for the target session.
- `purge_session` refuses to purge an active session.
- Rebuild from SQLite alone (with empty `session_events.jsonl`) restores all session state.
- Backup-restore round-trip: copy `data/`, blow away the originals, copy back, verify all sessions readable.

**Acceptance (R3):**

- No JSONL line for a state-transition event type is emitted in normal operation.
- `purge_session` works end-to-end.
- Backup docs match reality.
- All existing tests pass.

### Phase 4 — Cleanup + docs polish (R4)

Drop the vestigial code, write the postmortem, mark the spec implemented.

**Code:**

- Delete the now-unreachable state-transition event handlers in the projection.
- Drop the `prior_status` column on the `sessions` table (vestigial since S1.1; mentioned in that spec's open questions as "drop in storage rearchitecture").
- Drop any other vestigial columns identified during R1–R3.
- `PROJECTION_SCHEMA_VERSION` bumped to 7.
- New migration `004-drop-vestigial.sql`.

**Docs:**

- README — Sessions section updated to describe the new architecture briefly. ("Sessions: current state in SQLite, timeline in `session_events.jsonl`, audit trail in `session_state_changes`.")
- **README — new "Backup strategy" section at the end** (canonical home for the topic, not just a sentence in R3's docs touch). Cover:
  - The three critical files (`data/events.jsonl`, `data/session_events.jsonl`, `data/librarian.sqlite`) and what each one stores authoritatively.
  - Why `librarian.sqlite` is now critical (was rebuildable pre-rearchitecture).
  - What's *not* critical and can be regenerated (`data/memories.md`, `data/sessions.legacy.jsonl`).
  - A concrete recommended approach: stop the MCP server (or accept a crash-consistent snapshot risk), copy the three files via `cp` / `rsync` to a separate disk or remote, restart. Include a one-liner example.
  - Restore procedure: copy the three files back, run `pnpm run rebuild` to regenerate the memory projection columns + `memories.md`, start the server.
  - Backup frequency guidance — daily for the canonical instance; ad-hoc before risky operations (migration runs, schema bumps).
  - Pointer to `docs/migration-sessions-storage.md` for the one-time R2 migration backup expectations.
- `CONTRIBUTING.md` — the "adding a new event type" section gets a note distinguishing memory events (still JSONL-canonical) from session timeline events (timeline-only) from session state transitions (don't add — model it as a SQLite update with a `session_state_changes` row).
- `TODO.md` — item #13 marked resolved.
- `specs/session-storage-rearchitecture.md` (this file) status → "Implemented YYYY-MM-DD".
- Update `AUTONOMOUS-BUILD-NOTES-26-05-21.md` (or its successor) to reflect closure.

**Tests:**

- Storage fixture regenerated to reflect the new schema sentinel (version 7).
- No behaviour tests change beyond what R1–R3 already covered.

**Acceptance (R4):**

- Vestigial code gone.
- Docs match reality.
- `pnpm run check:schema-version` passes at 7.
- `TODO.md` #13 marked closed.

## Summary

| Phase | PR | What | New PROJECTION_SCHEMA_VERSION |
|---|---|---|---|
| 1 | R1 | Dual-write + authoritative schema | 5 |
| 2 | R2 | Migration script + CI divergence check + operator runbook | 5 (no schema change) |
| 3 | R3 | Single-write path + `purge_session` MCP tool + backup docs | 6 |
| 4 | R4 | Cleanup + docs polish | 7 |

4 PRs, serial. Each leaves `main` releasable. Each schema bump triggers a one-time projection rebuild on the canonical instance.

## Risks + mitigations

- **Data loss if SQLite is corrupted post-R3 without backup.** The architecture intentionally trades the JSONL-canonical safety net for the right model. Mitigation: backup docs are loud and clear; the canonical instance should have a regular `librarian.sqlite` backup (cron + rsync). A future "automatic snapshot" tool could land in a follow-up.
- **Divergence during dual-write (R1).** The two writes aren't transactional. Mitigation: R2's CI guard catches divergence; R1's property test catches it pre-merge. If we observe a real divergence in production during R1, the SQLite write is authoritative and the JSONL replay is treated as a secondary view.
- **Migration script gets the state mapping wrong.** Mitigation: R2 ships against fixtures covering all five retired transition event types; the operator runbook explicitly says to back up first; the migration is idempotent so it can be re-run.
- **`purge_session` JSONL rewrite is slow on large files.** Mitigation: not a hot path (admin-gated, rare). If it becomes a problem, switch to a tombstone-then-compact model in a follow-up.
- **Cross-paradigm cognitive load for new contributors.** Memories are JSONL-canonical, sessions are SQLite-canonical. Mitigation: `CONTRIBUTING.md` gets a clear explainer in R4; the model differences are themselves a meaningful design statement (use the right tool for each).

## Open questions

- **Should `session_state_changes` cap its row count per session?** Active sessions could accumulate hundreds of pause/resume transitions during long-lived development. Not urgent; revisit if it becomes a query-performance issue.
- **Should we keep `sessions.legacy.jsonl` indefinitely, or add a purge step in a future release?** Probably indefinitely on canonical, optionally compressed. It's the pre-migration audit anchor.
- **Should `purge_session` cascade to memories promoted from that session?** No — promoted memories are independent entities with their own `mem_…` ids; the cross-link is informational, not a foreign key. Purging the session leaves the promoted memories intact with a "source session purged" annotation, if anything. Decide concretely in R3.
- **Backup snapshot tooling.** Worth a `scripts/backup-data.sh` that snapshots all three critical files atomically? Probably yes as a follow-up; out of scope here.
- **Do we expose the `session_state_changes` audit trail via a tRPC procedure for the dashboard's Activity tab?** Yes, as part of R3 (a `sessions.history` procedure). The dashboard surface change is out of scope here.

## Acceptance review (for this spec)

- **Are we sure breaking the memory/session symmetry is worth it?** Yes — the symmetry was never load-bearing; it was a stylistic copy-paste from when sessions were first introduced. The two storage shapes serve different access patterns (memories: low-write, append-only, rebuildable; sessions: high-write, state-machine-shaped, accumulating). The right design has always been two paradigms.
- **Are we creating a worse backup story?** Yes, mechanically — three critical files vs. one. The mitigation is loud documentation and a future backup script. The trade is worth it because the current "one critical file" story is a fiction: the projection's correctness depends on SQLite even today, and a corrupted `librarian.sqlite` already requires a rebuild that takes meaningful time. The new model just makes the storage architecture honest about what it depends on.
- **Could we do this without dual-write?** Yes, but it would be reckless. The dual-write phase is cheap (one extra append per transition) and the verification it enables is worth the temporary complexity. R3 cuts it as soon as we have CI-level confidence.
- **Why not move memories to SQLite-canonical too while we're at it?** Memories don't share the awkwardness. Every memory event is a state-changing fact; the projection rebuilds in milliseconds; volume plateaus; the write rate is human-scale (a few events per day, not per session). The JSONL-canonical model fits memories well. Don't fix what isn't broken.

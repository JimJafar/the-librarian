# Operator runbook: sessions storage migration (R2)

This document walks through the one-time conversion from the
JSONL-canonical sessions model to the hybrid model where SQLite holds
the authoritative current state and `session_events.jsonl` carries
only the timeline events.

Skip this page if you haven't yet pulled R2; come back when you do.

## What changes

| Before R2                          | After R2                                                                       |
|------------------------------------|--------------------------------------------------------------------------------|
| `data/sessions.jsonl` (canonical)  | `data/sessions.legacy.jsonl` (frozen, audit-only)                              |
| —                                  | `data/session_events.jsonl` (new; timeline events only, no state transitions)  |
| Session status = projection        | Session status = authoritative SQLite row (already true behaviourally post-R1) |
| `librarian.sqlite` = projection    | `librarian.sqlite` = authoritative for sessions + projection for memories      |

State-transition events (`session.started`, `session.checkpointed`,
`session.paused`, `session.ended`, plus the historical
`session.archived` / `session.deleted` / `session.restored`) are not
copied into the new `session_events.jsonl`. They live in
`session_state_changes` (added in R1) and the `sessions` row itself.

Note: R2 ships **the migration script and runbook** only. The runtime
still writes to `sessions.jsonl` until R3 lands. Running R2's
migration with R3 unreleased means new sessions will keep producing
state-transition lines in a freshly-recreated `sessions.jsonl` —
that's expected and gets cleaned up when R3 cuts the runtime over.

If you want to wait for R3 before migrating, that's fine — R2 is
a tooling-only release.

## Before you start

1. **Back up your `data/` directory in full.** A `cp -a data data.pre-r2`
   in the working directory is sufficient; you want a snapshot you can
   restore from if anything goes wrong.
2. **Stop the MCP server.** The migration mutates files under `data/`
   and a concurrent write from the live process could leave the ledger
   half-renamed.

## Running the migration

```sh
# Dry-run first — prints the summary without changing any files.
node scripts/migrate-sessions-to-authoritative-sqlite.mjs

# When the dry-run numbers look right, commit the change.
node scripts/migrate-sessions-to-authoritative-sqlite.mjs --apply
```

The script prints a summary like:

```
Sessions storage migration
============================================================
data dir:                /var/lib/librarian/data
sessions.jsonl lines:    1247
  → timeline (kept):     842
  → state transitions:   405  (encoded in SQLite + session_state_changes)
  → unparseable (drop):  0
SQLite sessions:         63
SQLite state changes:    405
============================================================
```

Expectations to sanity-check:

- `timeline + state transitions + unparseable` should equal the line
  count of `sessions.jsonl`.
- `SQLite state changes` should equal the `state transitions` count
  (each historical transition produced exactly one
  `session_state_changes` row via the R1 projection).
- `SQLite sessions` should match what `list_sessions --include-ended`
  returns from the CLI.

If the numbers look off, **do not run `--apply`**. Investigate first;
the dry run is non-destructive.

## After the migration

1. **Run the divergence check:**
   ```sh
   node scripts/check-session-state-divergence.mjs --data-dir ./data
   ```
   This walks every session and asserts that its `sessions.status`
   matches the last `to_status` in `session_state_changes`. A clean
   pass means the SQLite-authoritative state is internally consistent
   with the audit trail.

2. **Restart the MCP server.** Verify it boots cleanly. The R1 schema
   sentinel (version 5) already migrated on first start, so this
   restart is a no-op apart from re-opening the SQLite handle.

3. **Verify a known session.** Pick a session id you've seen recently,
   call `get_session` from the dashboard or CLI, and confirm the
   `status`, `rolling_summary`, and timestamps look right.

4. **Verify `list_sessions` defaults.** Should match pre-migration
   counts (active + paused sessions).

## Rollback

If you need to undo:

1. Stop the server.
2. Restore the `data/` backup you took before starting.
3. Restart the server. R1's projection rebuild reseeds
   `session_state_changes` from JSONL on first start.

The post-migration files are:

- `data/sessions.legacy.jsonl` — frozen, can be safely deleted if the
  backup above is intact.
- `data/session_events.jsonl` — new timeline ledger, also safely
  deletable (R3's purge would do the equivalent operation).
- `data/librarian.sqlite` — keep this; it's the new authoritative
  source post-R3.

## Idempotency

Running the migration script a second time is safe: it detects the
renamed `sessions.legacy.jsonl` and exits without changes.

## What's next

- **R3** cuts the runtime over to write timeline events to
  `session_events.jsonl` and stop emitting state-transition events to
  any JSONL. SQLite becomes the only place state lives.
- **R4** drops the vestigial `prior_status` column and tightens the
  docs to reflect the new architecture.

Until R3, the runtime keeps the old write path. That's deliberate —
the migration is a tooling step, not a behaviour change. The R3 PR
will reference this runbook as a prerequisite.

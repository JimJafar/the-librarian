# Autonomous Build Notes — 2026-05-21 (specs implementation run)

Sibling to `AUTONOMOUS-BUILD-NOTES-26-05-21.md` (which covered the V1.x / S1.x / D1.x autonomous run earlier today). This run implemented the three new specs drafted at the end of that run:

- `specs/done/integration-docs-memory-verbs.md` — 1 PR (I1)
- `specs/done/ui-library-consolidation.md` — 3 PRs (U1, U2, U3)
- `specs/done/session-storage-rearchitecture.md` — 4 PRs (R1, R2, R3, R4)

**Order chosen:** I1 → U1 → U2 → U3 → R1 → R2 → R3 → R4. All 8 PRs landed green.

## Run progress — final

**Integration docs (1 PR) — DONE**
- ~~I1~~ V1.x memory verbs propagated into all 5 harness agent docs + new MCP tool-surface healthcheck — PR #60

**UI library consolidation (3 PRs) — DONE**
- ~~U1~~ Built `ui-v2/dialog`, `input`, `table`, `tabs` atoms — PR #61
- ~~U2~~ Migrated Sessions surface to ui-v2 — PR #62
- ~~U3~~ Migrated Memories + recall + theme-toggle, deleted `components/ui/`, added ESLint guard — PR #63

**Session storage rearchitecture (4 PRs) — DONE**
- ~~R1~~ `sessions.state_version` + `session_state_changes` audit table — PR #64
- ~~R2~~ Migration script + CI divergence guard + operator runbook — PR #65
- ~~R3~~ Runtime cutover to SQLite-canonical sessions + `purge_session` tool — PR #66
- ~~R4~~ README backup section + TODO #13 resolved + spec close-outs — PR #67 (this PR)

## Acceptance criteria — met / deferred

| Spec | Acceptance | Status |
|---|---|---|
| integration-docs-memory-verbs | Each harness doc carries memory three-state paragraph + verify-after-recall guidance; healthcheck asserts V1.x + S1.x contract. | **Met.** |
| ui-library-consolidation | `apps/dashboard/components/ui/` does not exist; ESLint enforces; both themes render across all surfaces. | **Met.** |
| session-storage-rearchitecture | Sessions row is SQLite-authoritative; timeline events in `session_events.jsonl`; `purge_session` MCP tool; backup story documented loudly. | **Met.** |

## Decisions made autonomously

- **No "purge_session" dashboard surface in R3.** The MCP tool + tRPC procedure are the durable interface. A dashboard "Purge" button would need confirmation UX; deferred to a separate dashboard PR.
- **`session_events.jsonl` is created empty by the store on init.** The R2 migration script was tightened to treat an empty file as a non-conflict (the runtime touches it on startup); only non-empty content triggers the abort.
- **`rebuildSessionIndex` is cold/warm split.** When sessions has rows (the post-R1 case), rebuild only refreshes the timeline projection without replaying state-transition handlers (which would double-count `state_version` + audit rows). When sessions is empty (cold rebuild from JSONL + legacy ledger merge), full replay runs.
- **Pre-R1 schema bumps still drop and rebuild sessions.** Instances at user_version < 5 lack the `state_version` column; they go through the legacy full-rebuild path. Post-R1 sessions data survives schema bumps.
- **`prior_status` column NOT dropped in R4.** The spec called for it but the risk-vs-gain ratio is poor: it's a single TEXT column nobody reads, dropping it requires `ALTER TABLE DROP COLUMN` machinery in ensureSchema, and a vestigial column is harmless. Left as a tiny piece of tech debt.
- **Pill variants `default | accent | muted`** chosen in U2 to map the 4-variant legacy Badge surface onto editorial restraint. `destructive` → `accent` (vermilion catches attention either way); `secondary` → `muted`; `outline` → `default`. Two `primary` buttons on the same row (proposals-view Approve / Reject) is the deliberate trade.
- **Dropped `size="sm"` everywhere.** Editorial direction favours consistent sizing; the legacy `size` prop is not in ui-v2 Button.
- **Healthcheck "MCP tool surface" check spawns with admin role.** Needed to see `archive_memory` + `approve_proposal` (both `adminOnly: true`) in the tool list.

## Deferred to future PRs

- **`prior_status` column drop on sessions.** Tiny tech debt; drop when the next sessions DDL change comes along.
- **Dashboard "Purge" surface for the new MCP tool.** Separate dashboard PR. The tRPC procedure (`sessions.purge`) is ready.
- **`session_events.jsonl` rotation.** Append-only forever is fine for a single operator; a future "rotate at N MB" tool could land alongside #10 (retention policy).
- **Auto-checkpoint hooks** (TODO #12). The R3 architecture handles the write-rate concern (state transitions don't go to JSONL anymore), so hook-driven checkpointing won't multiply ledger size.
- **`scripts/backup-data.sh` snapshot script.** The README points operators at `rsync` directly; a wrapper that handles stop-server / SQLite-online-backup would be a nice operational complement.

## Open questions for you

- **Operator runbook for the R2 migration.** Documented in `docs/migration-sessions-storage.md`; please review before running on the canonical instance. Backup first.
- **Backup automation.** The README section calls for daily backups but doesn't ship a script. A `scripts/backup-data.sh` that snapshots the three critical files (with stop-server / online-backup options) would be useful.

## Follow-ups for you

1. **Run the R2 migration** on the canonical instance (after backing up `data/` in full). The runbook is in `docs/migration-sessions-storage.md`. Dry-run first; the summary numbers should match your live state. Then `--apply`.
2. **Verify the canonical instance** boots cleanly after R3 deploy — schema version stamps to 6, all sessions accessible via `get_session`, `list_sessions` defaults match pre-deploy counts.
3. **Run `pnpm run check:session-state-divergence --data-dir /path/to/canonical/data`** post-migration to confirm SQLite ↔ session_state_changes parity.
4. **Wire `LIBRARIAN_AGENT_TOKENS` on the canonical server** (TODO #4) — still the easiest operational win.
5. **Decide on a backup cadence** — daily cron-driven rsync is the obvious answer; a `scripts/backup-data.sh` companion would make it one-line.

## Stranger-test checklist (spec acceptance, manual)

- [ ] **Integration docs.** Open a fresh Claude Code session, ask the agent to recall something you've previously remembered, and watch whether the agent follows up with `verify_memory`. If it doesn't, the priming text didn't land; consider promoting the verify-after-recall guidance from "Working principle" to a bolded one-liner.
- [ ] **UI consolidation.** Walk all three primary surfaces (Memories list + detail panel + rehome modal; Sessions list + detail + lifecycle actions; Recall surface + cmd-K) in both Manuscript and Scriptorium themes. Confirm no shadcn-style rounded corners or pale grey hover backgrounds slipped through.
- [ ] **Backup recovery.** With a non-production data dir: stop server, snapshot all three files, delete `data/`, restore from snapshot, restart, confirm sessions + memories survived. The R2 runbook covers the procedure.
- [ ] **`purge_session` end-to-end.** Create a throwaway session, end it, then call `purge_session` via the MCP tool. Confirm the session disappears from `list_sessions` AND that `session_events.jsonl` no longer contains lines for that session id.

## CI cost summary

8 PRs × ~2m45s for the lint/typecheck/test/build/smoke/healthcheck/guards job + ~1m30s for e2e + 4×~22s for harness wrapper smokes = roughly 5-6 minutes of CI machine time per PR. ~45 minutes total for the run.

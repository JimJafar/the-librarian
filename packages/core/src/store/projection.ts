// SQLite projection module — owns the schema and the rebuild + incremental
// insert paths for both memory and session ledgers.
//
// Public surface:
//   - PROJECTION_SCHEMA_VERSION             — bump when the SQLite shape changes
//   - getSchemaVersion(db)                  — read PRAGMA user_version
//   - ensureSchema(db, paths)               — version-gated rebuild on store open
//   - initSchema(db)                        — CREATE TABLE / VIRTUAL TABLE
//   - reduceMemoryLog(entries)              — pure: log → {memories, events}
//   - rebuildMemoryIndex(db, paths)         — full rebuild from events.jsonl
//   - rebuildSessionIndex(db, sessionsPath) — full rebuild from sessions.jsonl
//   - applySessionEvent(db, event)          — single session-event projection
//   - writeMemorySnapshot(path, memories)   — markdown snapshot writer
//
// Behavior must remain byte-identical to the pre-T3.2 inlined version in
// store.js — the rebuild-parity tests in tests/store/projection.test.ts
// verify that.

import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { actorKind } from "../caller-identity.js";
import { MemoryEventType, MemoryStatus, VerifyResult } from "../schemas/common.js";
import { appendJsonl, readJsonl } from "./jsonl.js";

// ---------- Local utilities ----------
// Mirrors `asArray` from constants.js. Inlined here so the TS source is
// self-contained until T3.5 ports constants.js to TS.
function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (value == null || value === "") return [];
  return [String(value)];
}

// ---------- SQLite schema ----------

// Bump whenever the SQLite shape changes (column add/drop/rename, new
// table, new FTS surface, etc.). On store open `ensureSchema` compares
// PRAGMA user_version to this constant; if the on-disk value is lower,
// the projection tables are dropped, recreated, and replayed from the
// JSONL ledgers. The JSONL files are the canonical source of truth, so
// the rebuild loses nothing.
//
// CI guard: `scripts/check-schema-version.mjs` hashes `SCHEMA_DDL` and
// compares it to `test/schema-snapshot.json`. Editing the DDL without
// bumping the version (and re-recording the fingerprint) fails CI.
// Bump history:
//   - 2: V1.2 memory state collapse (active|proposed|archived).
//   - 3: S1.1 session state collapse (active|paused|ended).
//   - 4: D1.1 added the `memory.bulk_updated` event type. The DDL is
//        unchanged but existing canonical instances need to roll forward
//        through the new projection handler at first start; bumping the
//        sentinel triggers that replay on next boot.
//   - 5: R1 added `sessions.state_version` + `session_state_changes`.
//        Dual-write (R1) keeps the JSONL ledger canonical; the new
//        columns + audit table seed R3's SQLite-canonical cutover.
//   - 6: R3 cuts the runtime over to SQLite-canonical sessions —
//        timeline events go to `session_events.jsonl`, state
//        transitions live in SQLite only. The DDL is unchanged; the
//        bump forces a one-time replay from the legacy ledger so any
//        existing sessions.jsonl rolls into the new shape.
//   - 7: naming contract §6/§14 — explicit `actor_kind` column on the
//        `memories` and `events` projections, derived from `agent_id`
//        via `actorKind`. The bump repopulates both on next boot (memory
//        side is JSONL-canonical, so the rebuild fills the new column).
//   - 8: memory-curator §8 — nullable `curator_note` JSON column on
//        `memories`, carried on the memory record and rebuilt from the
//        events ledger like the other memory fields.
//   - 9: memory-curator §8 — `memory_curation_runs` +
//        `memory_curation_operations` tables. Like `sessions`, these are
//        SQLite-authoritative (not ledger projections) and are preserved
//        across bumps; the bump just CREATEs them on existing installs.
//   - 10: memory-curator §7.1 — `settings` table (admin secret-store).
//         Authoritative; preserved across bumps; the bump just CREATEs it.
//   - 11: curator evidence-query indexes — idx_events_memory and
//         idx_session_events_session back the offline-batch evidence
//         queries (tombstone archive-reason subqueries on `events`;
//         per-session evidence on `session_events`). They serve the
//         equality + IN(...) filter (the scan→search win); the trailing
//         created_at is a small covering tail (the queries' IN / CASE
//         ORDER BY still uses a tiny temp sort over the filtered rows).
//         Index-only change; the bump recreates them on next boot (both
//         indexed tables are dropped+rebuilt on a bump anyway).
//   - 12: memory-domain-isolation PR 1 / T1.1 — adds the four owner-
//         controlled tables for the new domain model: `conversation_state`
//         (per-conversation runtime state surviving compaction),
//         `domains` (flat owner-managed list, seeded with `general`),
//         `signal_rules` (harness-pattern → domain), and
//         `token_domain_bindings` (token → default domain). All four are
//         SQLite-authoritative — no JSONL ledger backs them — so they
//         are explicitly preserved across future bumps alongside
//         `sessions` and `settings`.
//   - 13: memory-domain-isolation PR 1 / T1.2 — adds `domain`,
//         `is_global`, `requires_approval` to `memories` and `domain` to
//         `sessions`. The memories columns ride the standard drop-and-
//         rebuild path (JSONL is canonical; defaults apply during
//         re-insertion). The sessions column is added via ALTER TABLE in
//         `ensureAuthoritativeTableColumns` because the sessions table
//         is SQLite-authoritative post-R1 and must not be dropped.
//   - 14: memory-domain-isolation PR 3 / T3.1 — drops the NOT NULL
//         constraint on `memories.domain`. Outside-session writes (spec
//         §4.14) land with `domain = NULL` and route to the proposal
//         queue, where the dashboard owner picks a domain at approval
//         time. Memories is JSONL-canonical so the bump drops + rebuilds
//         the table from the ledger; the default 'general' still applies
//         to writes that omit the column.
//   - 15: classifier-implementation Section 4a / Task 4.4 — adds
//         `classified` and `classification_attempts` to `memories`. Both
//         default to 0 and are written by the future classifier worker
//         (Section 4d wires it; 4a/4b/4c land the machinery without
//         flipping the bit). Memories is JSONL-canonical so the bump
//         drops + rebuilds and the defaults apply to every existing row.
//         The INSERT in `rebuildMemoryIndex` omits both columns so the
//         defaults take effect for existing memories on bump; new
//         memories written through `createMemory` likewise inherit the
//         defaults until the worker writes a verdict.
//   - 16: sessions-rethink PR 0 / Task 0.5 — drops `input_session_ids`
//         from `memory_curation_runs` and `source_session_ids` from
//         `memory_curation_operations`. The curator is memory-only after
//         the rethink (§12); the columns become dead. The DDL drops them
//         via ALTER TABLE … DROP COLUMN (SQLite ≥3.35) inside
//         `ensureAuthoritativeTableColumns`. Existing curation rows are
//         preserved.
//   - 17: sessions-rethink PR 1 / Task 1.3 — adds the `handoffs` table
//         (the new cross-harness narrative-handover surface, spec §6.2)
//         alongside the existing session tables. Additive; old sessions
//         surface is untouched. The partial-unclaimed index supports the
//         §6.1 default picker filter. Authoritative; preserved across
//         future bumps.
//   - 18: sessions-rethink PR 7 — drops the entire session subsystem
//         (sessions, session_state_changes, session_events,
//         session_events_fts and its FTS5 shadow tables). Memory side
//         (memories, events, memories_fts) and the authoritative tables
//         (settings, curation_*, conv_state, domains, handoffs, …) are
//         preserved. The on-disk JSONL ledgers for sessions are renamed
//         to `.predeprecation.bak` by `createLibrarianStore`.
export const PROJECTION_SCHEMA_VERSION = 19;

export function getSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

function stampSchemaVersion(db: DatabaseSync): void {
  db.exec(`PRAGMA user_version = ${PROJECTION_SCHEMA_VERSION}`);
}

function dropProjectionTables(db: DatabaseSync): void {
  // The `memory_curation_*` tables (memory-curator §8), `settings`
  // (§7.1 admin secret-store), `conversation_state`, `domains`,
  // `signal_rules`, `token_domain_bindings`, and `handoffs` are all
  // SQLite-authoritative and must survive schema-version bumps. Future
  // DDL changes to authoritative tables go through `ensureAuthoritative
  // TableColumns` (ALTER TABLE), not this drop+rebuild path. Memory
  // side is JSONL-canonical so the rebuild replays from the ledger.
  //
  // sessions-rethink PR 7 — `sessions`, `session_state_changes`,
  // `session_events`, and `session_events_fts` (with its FTS5 shadow
  // tables) are explicitly dropped so existing operator DBs migrate
  // cleanly. The FTS shadow tables (`session_events_fts_data`,
  // `_idx`, `_docsize`, `_config`) are dropped first because SQLite
  // refuses to drop the virtual table if its shadows are missing.
  db.exec(`
    DROP TABLE IF EXISTS memories_fts;
    DROP TABLE IF EXISTS memories;
    DROP TABLE IF EXISTS events;
    DROP TABLE IF EXISTS session_events_fts_data;
    DROP TABLE IF EXISTS session_events_fts_idx;
    DROP TABLE IF EXISTS session_events_fts_docsize;
    DROP TABLE IF EXISTS session_events_fts_config;
    DROP TABLE IF EXISTS session_events_fts;
    DROP TABLE IF EXISTS session_events;
    DROP TABLE IF EXISTS session_state_changes;
    DROP TABLE IF EXISTS sessions;
  `);
}

export interface EnsureSchemaPaths {
  eventsPath: string;
  snapshotPath: string;
}

/**
 * Schema-version gate, run once per store open. If the on-disk
 * `PRAGMA user_version` is below `PROJECTION_SCHEMA_VERSION`, the
 * projection tables are dropped, recreated via `initSchema`, and
 * replayed from the JSONL ledgers — then the version is stamped.
 * Otherwise tables are ensured (idempotent CREATE IF NOT EXISTS) and
 * the existing projection is trusted.
 *
 * Returns `true` if a rebuild ran.
 */
export function ensureSchema(db: DatabaseSync, paths: EnsureSchemaPaths): boolean {
  const onDisk = getSchemaVersion(db);
  if (onDisk >= PROJECTION_SCHEMA_VERSION) {
    initSchema(db);
    ensureAuthoritativeTableColumns(db);
    seedDomains(db);
    return false;
  }
  dropProjectionTables(db);
  initSchema(db);
  ensureAuthoritativeTableColumns(db);
  seedDomains(db);
  rebuildMemoryIndex({
    db,
    eventsPath: paths.eventsPath,
    snapshotPath: paths.snapshotPath,
  });
  stampSchemaVersion(db);
  return true;
}

// The canonical projection DDL. Exported so the CI guard
// (`scripts/check-schema-version.mjs`) can hash it and verify that
// edits ship alongside a `PROJECTION_SCHEMA_VERSION` bump + snapshot
// update.
export const SCHEMA_DDL = `
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      agent_id TEXT,
      actor_kind TEXT,
      project_key TEXT,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      confidence TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      applies_to_json TEXT NOT NULL,
      supersedes_json TEXT NOT NULL,
      conflicts_with_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_recalled_at TEXT,
      recall_count INTEGER NOT NULL,
      usefulness_score INTEGER NOT NULL,
      curator_note TEXT,
      domain TEXT DEFAULT 'general',
      is_global INTEGER NOT NULL DEFAULT 0,
      requires_approval INTEGER NOT NULL DEFAULT 0,
      classified INTEGER NOT NULL DEFAULT 0,
      classification_attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      id UNINDEXED,
      title,
      body,
      tags
    );
    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      memory_id TEXT,
      agent_id TEXT,
      actor_kind TEXT,
      created_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_memory
      ON events(memory_id, event_type, created_at);
    CREATE TABLE IF NOT EXISTS memory_curation_runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      trigger TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'apply',
      project_key TEXT,
      visibility TEXT NOT NULL,
      agent_id TEXT,
      input_hash TEXT NOT NULL,
      input_memory_ids TEXT NOT NULL,
      model_provider TEXT,
      model_name TEXT,
      usage_input_tokens INTEGER NOT NULL DEFAULT 0,
      usage_output_tokens INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS memory_curation_operations (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      operation_type TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence REAL NOT NULL,
      risk_level TEXT NOT NULL,
      source_memory_ids TEXT NOT NULL,
      target_memory_ids TEXT NOT NULL,
      title TEXT,
      rationale TEXT NOT NULL,
      proposed_payload TEXT NOT NULL,
      applied_at TEXT,
      error TEXT,
      FOREIGN KEY (run_id) REFERENCES memory_curation_runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_curation_operations_run
      ON memory_curation_operations(run_id, id);
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      is_secret INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversation_state (
      conv_id TEXT PRIMARY KEY,
      harness TEXT NOT NULL,
      domain TEXT NOT NULL,
      session_id TEXT,
      off_record INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS domains (
      name TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS signal_rules (
      id TEXT PRIMARY KEY,
      harness TEXT NOT NULL,
      pattern TEXT NOT NULL,
      domain TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS token_domain_bindings (
      token_id TEXT PRIMARY KEY,
      domain TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS handoffs (
      id                      TEXT PRIMARY KEY,
      title                   TEXT NOT NULL,
      document_md             TEXT NOT NULL,
      project_key             TEXT,
      source_ref              TEXT,
      cwd                     TEXT,
      domain                  TEXT NOT NULL,
      created_by_agent_id     TEXT,
      created_in_harness      TEXT,
      tags_json               TEXT NOT NULL DEFAULT '[]',
      created_at              TEXT NOT NULL,
      claimed_at              TEXT,
      claimed_by_json         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_handoffs_unclaimed
      ON handoffs(domain, project_key, cwd, created_at)
      WHERE claimed_at IS NULL;
  `;

export function initSchema(db: DatabaseSync): void {
  db.exec(SCHEMA_DDL);
}

/**
 * Seed the floor of the owner-managed domain list with `general`. The
 * domain model treats single-domain installs as zero-friction (the
 * session-start prompt collapses to a no-op), so every install needs
 * at least this one row present. Uses `INSERT OR IGNORE` so subsequent
 * boots are idempotent — owner-added domains are untouched.
 */
export function seedDomains(db: DatabaseSync): void {
  db.prepare("INSERT OR IGNORE INTO domains (name, created_at) VALUES (?, ?)").run(
    "general",
    new Date().toISOString(),
  );
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

/**
 * Add columns to SQLite-authoritative tables that CREATE TABLE IF NOT
 * EXISTS can't introduce on existing instances. The `sessions` table is
 * preserved across schema bumps (post-R1), so additive columns on it
 * have to land via ALTER TABLE.
 *
 * Idempotent: each ALTER is guarded by a PRAGMA table_info() probe, so
 * fresh databases (where the columns came in via SCHEMA_DDL) are
 * untouched.
 */
export function ensureAuthoritativeTableColumns(db: DatabaseSync): void {
  // T1.2 — `sessions.domain` defaults to 'general' so existing rows
  // pick up the no-op single-domain value without any per-row backfill.
  if (!hasColumn(db, "sessions", "domain")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN domain TEXT NOT NULL DEFAULT 'general'`);
  }
  // PR 0 Task 0.5 — drop curator session columns from authoritative tables
  // (sessions-rethink §12). SQLite ≥3.35 supports DROP COLUMN; the projects
  // ship better-sqlite3 / node:sqlite that meet that floor. Guarded by a
  // PRAGMA probe so it's idempotent.
  if (hasColumn(db, "memory_curation_runs", "input_session_ids")) {
    db.exec(`ALTER TABLE memory_curation_runs DROP COLUMN input_session_ids`);
  }
  if (hasColumn(db, "memory_curation_operations", "source_session_ids")) {
    db.exec(`ALTER TABLE memory_curation_operations DROP COLUMN source_session_ids`);
  }
}

// ---------- Memory side ----------

// Memory rows are loosely typed here because the existing JS code stuffs
// extra fields (deleted_at, etc.) into snapshots and we want to preserve
// behavior exactly. Tightening to `Memory` from @librarian/core/schemas is a
// follow-up after T3.3 has settled the canonical shape.
type MemoryRecord = Record<string, unknown> & { id: string };

/**
 * Derive the three new domain-isolation columns (`domain`, `is_global`,
 * `requires_approval`) for a single reduced memory record before it
 * lands in the projection.
 *
 * Pre-T1.3 events have none of these on their snapshot; post-T1.3 events
 * have all three. The fallback path keeps the rebuild from any-era JSONL
 * coherent with the spec — `agent_private` rows go to the synthetic
 * `legacy-private` domain, and the booleans come from the category-based
 * derivation that PR 1's classifier-shadow phase will later supersede.
 *
 * Returned as a positional tuple so `insertMemory.run(...)` can spread
 * it directly into the prepared statement's bind list.
 */
function deriveDomainColumns(m: Record<string, unknown>): [string | null, number, number] {
  // Historical snapshots carried a `visibility` field with values
  // "common" | "agent_private" — that enum is retired but the legacy
  // value still appears on pre-cutover ledger events, so we map it to
  // the synthetic `legacy-private` domain to preserve isolation.
  const fallbackDomain = m.visibility === "agent_private" ? "legacy-private" : "general";

  // PR 3 / spec §4.14 — outside-session writes carry an explicit
  // `domain: null` on the snapshot to mark them as awaiting owner
  // assignment in the proposal queue. Distinguish this from "field
  // absent on a legacy event" via `hasOwn`: absent → fall back to the
  // visibility-derived value; present null → preserve.
  const explicitDomain = Object.prototype.hasOwnProperty.call(m, "domain");
  const domain = explicitDomain ? ((m.domain as string | null) ?? null) : fallbackDomain;
  // Section 4d.2 — the legacy `deriveLegacyMemoryFlags(category)` bridge
  // is retired. Snapshots that pre-date the classifier cutover lack
  // `is_global` / `requires_approval`; they default to (false, false)
  // here. The 4d.1 backfill migration (memory.updated events with
  // `{classified: 0}`) re-enqueues those rows so the classifier can
  // produce real verdicts.
  const isGlobal = Boolean(m.is_global ?? false);
  const requiresApproval = Boolean(m.requires_approval ?? false);

  return [domain, isGlobal ? 1 : 0, requiresApproval ? 1 : 0];
}

interface MemoryLogEvent {
  event_id: string;
  event_type: MemoryEventType;
  memory_id?: string | null;
  agent_id?: string | null;
  created_at: string;
  payload?: Record<string, unknown>;
}

/**
 * Replay the memory event log into the latest `{ memories, events }`
 * snapshot. Pure — no I/O, no DB.
 */
export function reduceMemoryLog(events: MemoryLogEvent[]): {
  memories: MemoryRecord[];
  events: MemoryLogEvent[];
} {
  const memories = new Map<string, MemoryRecord>();
  const eventRows: MemoryLogEvent[] = [];

  for (const event of events) {
    eventRows.push(event);
    const payload = (event.payload || {}) as Record<string, unknown>;
    const payloadMemory = payload.memory as MemoryRecord | undefined;
    const id = event.memory_id || (payload.memory_id as string | undefined) || payloadMemory?.id;
    if (!id) continue;

    if (
      event.event_type === MemoryEventType.Created ||
      event.event_type === MemoryEventType.Proposed
    ) {
      if (payloadMemory) memories.set(id, { ...payloadMemory });
      continue;
    }

    const existing = memories.get(id);
    if (!existing) continue;

    switch (event.event_type) {
      case MemoryEventType.Updated:
        memories.set(id, {
          ...existing,
          ...(payload.patch as Record<string, unknown>),
          id,
          updated_at: event.created_at,
        });
        break;
      case MemoryEventType.Approved:
        memories.set(id, {
          ...existing,
          ...(payload.patch as Record<string, unknown>),
          status: MemoryStatus.Active,
          updated_at: event.created_at,
        });
        break;
      case MemoryEventType.Rejected:
        // Post-V1.2 the proposal-reject path archives the row instead of
        // carrying a separate `rejected` state.
        memories.set(id, {
          ...existing,
          status: MemoryStatus.Archived,
          updated_at: event.created_at,
        });
        break;
      case MemoryEventType.Deleted:
        // Legacy `memory.deleted` events project to archived; the spec
        // collapsed the soft-delete state into archive in V1.2.
        memories.set(id, {
          ...existing,
          status: MemoryStatus.Archived,
          deleted_at: event.created_at,
          updated_at: event.created_at,
        });
        break;
      case MemoryEventType.Archived:
        memories.set(id, {
          ...existing,
          status: MemoryStatus.Archived,
          updated_at: event.created_at,
        });
        break;
      case MemoryEventType.Recalled:
        memories.set(id, {
          ...existing,
          last_recalled_at: event.created_at,
          recall_count: Number(existing.recall_count || 0) + 1,
          updated_at: existing.updated_at,
        });
        break;
      case MemoryEventType.Verified: {
        // Useful / not_useful nudge the usefulness_score by ±1, clamped to
        // ±3 — the same range as the priority and project-match bands in
        // recall scoring. Outdated is handled by the paired memory.archived
        // event below; it leaves the score alone. Legacy "wrong" verdicts
        // in older ledgers project as not_useful so replay stays meaningful.
        const result = payload.result;
        let delta = 0;
        if (result === VerifyResult.Useful) delta = 1;
        else if (result === VerifyResult.NotUseful || result === "wrong") delta = -1;
        const current = Number(existing.usefulness_score || 0);
        const next = Math.max(-3, Math.min(3, current + delta));
        memories.set(id, {
          ...existing,
          usefulness_score: next,
          updated_at: event.created_at,
        });
        break;
      }
      case MemoryEventType.UsefulnessAdjusted: {
        // Backfill event written by `scripts/replay-verify-outcomes.mjs`.
        // Applies a pre-clamped delta against the score and re-clamps to
        // ±3 defensively so a malformed backfill can't push past bounds.
        const delta = Number(payload.score_delta || 0);
        const current = Number(existing.usefulness_score || 0);
        const next = Math.max(-3, Math.min(3, current + delta));
        memories.set(id, {
          ...existing,
          usefulness_score: next,
          updated_at: event.created_at,
        });
        break;
      }
      case MemoryEventType.BulkUpdated: {
        // D1.1 — applies the patch (validated upstream to a whitelist of
        // agent_id + project_key) to the memory. `transaction_id` is on
        // the payload but the projection doesn't index it; it lives in
        // the ledger as the link for a future `bulkRevert` call.
        memories.set(id, {
          ...existing,
          ...(payload.patch as Record<string, unknown>),
          updated_at: event.created_at,
        });
        break;
      }
      case MemoryEventType.ConflictDetected: {
        // The detector machinery was retired in V1.2 — the projection
        // still records the conflicts_with linkage for older ledger
        // lines, but never mutates status. (Status mutations historically
        // pointed at the now-removed `conflicted` enum value.)
        const conflicts = new Set(asArray(existing.conflicts_with));
        for (const cid of asArray(payload.conflicts_with)) conflicts.add(cid);
        memories.set(id, {
          ...existing,
          conflicts_with: [...conflicts],
          updated_at: event.created_at,
        });
        break;
      }
      case MemoryEventType.Classified: {
        // classifier-implementation Section 4d cutover — apply the
        // worker's verdict to the snapshot so the booleans + classified
        // flag survive projection rebuild. `parsed` is the verdict the
        // model produced (null on a max_retries giveup, in which case
        // we still flip classified=1 with the conservative defaults
        // already in the payload).
        const parsed = payload.parsed as
          | { requires_approval: boolean; is_global: boolean }
          | null
          | undefined;
        const verdict = parsed ?? {
          requires_approval: true,
          is_global: false,
        };
        // Status promotion mirrors the worker's SQL update: a row that
        // landed in `proposed` (the conservative-default landing state
        // for pendingClassification writes) becomes `active` when the
        // classifier decides no approval is needed.
        const promotedStatus =
          existing.status === MemoryStatus.Proposed && verdict.requires_approval === false
            ? MemoryStatus.Active
            : existing.status;
        memories.set(id, {
          ...existing,
          is_global: verdict.is_global,
          requires_approval: verdict.requires_approval,
          status: promotedStatus,
          classified: 1,
          classification_attempts:
            (payload.attempt_number as number | undefined) ?? existing.classification_attempts ?? 0,
          updated_at: event.created_at,
        });
        break;
      }
      case MemoryEventType.ConflictResolved: {
        // Historical event; V1.2 retired the emitter. The legacy payload
        // shape is { resolution: "archive" | "supersede" | "keep_both",
        //            status: MemoryStatus value, patch?: ... }
        // — the old emitter pre-computed the post-resolution status into
        // `payload.status` (an actual MemoryStatus, not the resolution
        // name), so we honor that directly. Legacy `status: "deleted"`
        // values fold into archived to match the new state model.
        const legacyStatus = payload.status as string | undefined;
        const resolutionStatus =
          legacyStatus === "archived" || legacyStatus === "deleted" || legacyStatus === "rejected"
            ? MemoryStatus.Archived
            : MemoryStatus.Active;
        memories.set(id, {
          ...existing,
          ...(payload.patch as Record<string, unknown>),
          status: resolutionStatus,
          updated_at: event.created_at,
        });
        break;
      }
    }
  }

  return { memories: [...memories.values()], events: eventRows };
}

export interface RebuildMemoryIndexPaths {
  db: DatabaseSync;
  eventsPath: string;
  snapshotPath: string;
}

/**
 * Full memory-projection rebuild from the events JSONL ledger. Replays the
 * log, wipes the memory + FTS + events tables, re-inserts, and writes the
 * markdown snapshot. Atomic via SQLite transaction.
 */
export function rebuildMemoryIndex({
  db,
  eventsPath,
  snapshotPath,
}: RebuildMemoryIndexPaths): void {
  const entries = readJsonl<MemoryLogEvent>(eventsPath);
  const { memories, events } = reduceMemoryLog(entries);

  const tx = db.prepare("BEGIN");
  const commit = db.prepare("COMMIT");
  const rollback = db.prepare("ROLLBACK");
  tx.run();
  try {
    db.exec("DELETE FROM memories; DELETE FROM memories_fts; DELETE FROM events;");
    const insertMemory = db.prepare(`
      INSERT INTO memories (
        id, title, body, agent_id, actor_kind, project_key,
        status, priority, confidence, tags_json, applies_to_json, supersedes_json,
        conflicts_with_json, created_at, updated_at, last_recalled_at, recall_count,
        usefulness_score, curator_note, domain, is_global, requires_approval,
        classified, classification_attempts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = db.prepare(
      "INSERT INTO memories_fts (id, title, body, tags) VALUES (?, ?, ?, ?)",
    );
    const insertEvent = db.prepare(`
      INSERT INTO events (event_id, event_type, memory_id, agent_id, actor_kind, created_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const memory of memories) {
      const m = memory as Record<string, unknown>;
      insertMemory.run(
        m.id as string,
        m.title as string,
        m.body as string,
        (m.agent_id as string) || null,
        m.agent_id ? actorKind(m.agent_id as string) : null,
        (m.project_key as string) || null,
        m.status as string,
        m.priority as string,
        m.confidence as string,
        JSON.stringify(asArray(m.tags)),
        JSON.stringify(asArray(m.applies_to)),
        JSON.stringify(asArray(m.supersedes)),
        JSON.stringify(asArray(m.conflicts_with)),
        m.created_at as string,
        m.updated_at as string,
        (m.last_recalled_at as string) || null,
        Number(m.recall_count || 0),
        Number(m.usefulness_score || 0),
        m.curator_note ? JSON.stringify(m.curator_note) : null,
        ...deriveDomainColumns(m),
        // Classifier-cutover (Section 4d): existing snapshots have no
        // `classified` field, so they default to 1 ("legacy bridge
        // values are authoritative — worker doesn't need to revisit").
        // Post-cutover writes set `classified: 0` in the snapshot, and
        // the memory.classified handler in `reduceMemoryLog` flips it
        // to 1 once the worker emits its verdict event.
        Number(m.classified ?? 1),
        Number(m.classification_attempts ?? 0),
      );
      insertFts.run(m.id as string, m.title as string, m.body as string, asArray(m.tags).join(" "));
    }

    for (const event of events) {
      insertEvent.run(
        event.event_id,
        event.event_type,
        event.memory_id || null,
        event.agent_id || null,
        event.agent_id ? actorKind(event.agent_id) : null,
        event.created_at,
        JSON.stringify(event.payload || {}),
      );
    }

    commit.run();
    writeMemorySnapshot(snapshotPath, memories);
  } catch (error) {
    rollback.run();
    throw error;
  }
}

export function writeMemorySnapshot(snapshotPath: string, memories: MemoryRecord[]): void {
  const visible = memories
    .filter((m) => m.status !== MemoryStatus.Archived)
    .sort((a, b) => {
      const keyA = `${String(a.status)}:${String(a.category)}:${String(a.title)}`;
      const keyB = `${String(b.status)}:${String(b.category)}:${String(b.title)}`;
      return keyA.localeCompare(keyB);
    });

  const lines: string[] = ["# The Librarian Memories", ""];
  for (const m of visible) {
    lines.push(`## ${String(m.title)}`);
    lines.push("");
    lines.push(String(m.body));
    lines.push("");
    lines.push(`- id: ${String(m.id)}`);
    lines.push(`- status: ${String(m.status)}`);
    lines.push(`- category: ${String(m.category)}`);
    lines.push(
      `- visibility: ${String(m.visibility)}${m.agent_id ? ` (${String(m.agent_id)})` : ""}`,
    );
    lines.push(`- scope: ${String(m.scope)}${m.project_key ? ` (${String(m.project_key)})` : ""}`);
    lines.push(`- priority: ${String(m.priority)}`);
    lines.push(`- confidence: ${String(m.confidence)}`);
    if (asArray(m.tags).length) lines.push(`- tags: ${asArray(m.tags).join(", ")}`);
    lines.push("");
  }
  fs.writeFileSync(snapshotPath, `${lines.join("\n").trim()}\n`, "utf8");
}

export { appendJsonl, readJsonl };

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
import {
  MemoryEventType,
  MemoryStatus,
  SessionEventType,
  SessionStatus,
  VerifyResult,
} from "../schemas/common.js";
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
export const PROJECTION_SCHEMA_VERSION = 13;

export function getSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

function stampSchemaVersion(db: DatabaseSync): void {
  db.exec(`PRAGMA user_version = ${PROJECTION_SCHEMA_VERSION}`);
}

function dropProjectionTables(db: DatabaseSync): void {
  // R3 — `sessions` and `session_state_changes` are SQLite-authoritative
  // and must survive schema-version bumps. The `memory_curation_*` tables
  // (memory-curator §8) and `settings` (§7.1 admin secret-store) are likewise
  // authoritative and intentionally absent here. T1.1 adds four more
  // SQLite-authoritative tables (`conversation_state`, `domains`,
  // `signal_rules`, `token_domain_bindings`) which must also survive
  // bumps — they're intentionally absent from this drop list. Future DDL
  // changes to authoritative tables should use ALTER TABLE rather
  // than the drop-and-rebuild pattern below. The other tables are projections
  // (memory side stays JSONL-canonical; session_events is rebuilt from
  // session_events.jsonl on every bump).
  db.exec(`
    DROP TABLE IF EXISTS memories_fts;
    DROP TABLE IF EXISTS memories;
    DROP TABLE IF EXISTS events;
    DROP TABLE IF EXISTS session_events_fts;
    DROP TABLE IF EXISTS session_events;
  `);
}

function dropAllTablesIncludingSessions(db: DatabaseSync): void {
  // Used only for the pre-R1 → post-R3 migration path. Pre-R1 instances
  // have a `sessions` table without `state_version`, so the DDL has to
  // be regenerated from scratch. The R1 sentinel bump did this last
  // time around; we keep the helper for any operator who jumps two
  // versions.
  db.exec(`
    DROP TABLE IF EXISTS memories_fts;
    DROP TABLE IF EXISTS memories;
    DROP TABLE IF EXISTS events;
    DROP TABLE IF EXISTS session_events_fts;
    DROP TABLE IF EXISTS session_events;
    DROP TABLE IF EXISTS session_state_changes;
    DROP TABLE IF EXISTS sessions;
  `);
}

export interface EnsureSchemaPaths {
  eventsPath: string;
  sessionsPath: string;
  // R3 — read-only legacy ledger replayed alongside session_events.jsonl
  // so an operator who hasn't yet run the migration script still gets a
  // correct rebuild on a fresh DB.
  sessionsLegacyPath?: string;
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
  // R3 — sessions table is SQLite-authoritative for instances at v5+.
  // Pre-R1 instances (onDisk < 5) still need the full drop+rebuild path
  // because their sessions table lacks `state_version`; the rebuild
  // recovers everything from the JSONL ledger.
  if (onDisk < 5) {
    dropAllTablesIncludingSessions(db);
  } else {
    dropProjectionTables(db);
  }
  initSchema(db);
  ensureAuthoritativeTableColumns(db);
  seedDomains(db);
  rebuildMemoryIndex({
    db,
    eventsPath: paths.eventsPath,
    snapshotPath: paths.snapshotPath,
  });
  rebuildSessionIndex(
    db,
    paths.sessionsPath,
    paths.sessionsLegacyPath ? { sessionsLegacyPath: paths.sessionsLegacyPath } : {},
  );
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
      category TEXT NOT NULL,
      visibility TEXT NOT NULL,
      agent_id TEXT,
      actor_kind TEXT,
      scope TEXT NOT NULL,
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
      domain TEXT NOT NULL DEFAULT 'general',
      is_global INTEGER NOT NULL DEFAULT 0,
      requires_approval INTEGER NOT NULL DEFAULT 0
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      id UNINDEXED,
      title,
      body,
      category,
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
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      project_key TEXT,
      status TEXT NOT NULL,
      prior_status TEXT,
      visibility TEXT NOT NULL,
      created_by_agent_id TEXT,
      current_agent_id TEXT,
      created_in_harness TEXT,
      current_harness TEXT,
      source_ref TEXT,
      cwd TEXT,
      start_summary TEXT,
      rolling_summary TEXT,
      end_summary TEXT,
      next_steps_json TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      capture_mode TEXT NOT NULL,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      paused_at TEXT,
      ended_at TEXT,
      archived_at TEXT,
      deleted_at TEXT,
      metadata_json TEXT NOT NULL,
      state_version INTEGER NOT NULL DEFAULT 0,
      domain TEXT NOT NULL DEFAULT 'general'
    );
    CREATE TABLE IF NOT EXISTS session_state_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      actor_agent_id TEXT,
      at TEXT NOT NULL,
      note TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_session_state_changes_session
      ON session_state_changes(session_id, id);
    CREATE TABLE IF NOT EXISTS session_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      agent_id TEXT,
      harness TEXT,
      source_ref TEXT,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_events_session
      ON session_events(session_id, type, created_at);
    CREATE VIRTUAL TABLE IF NOT EXISTS session_events_fts USING fts5(
      event_id UNINDEXED,
      session_id,
      summary,
      payload_text
    );
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
      input_session_ids TEXT NOT NULL,
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
      source_session_ids TEXT NOT NULL,
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
}

// ---------- Memory side ----------

// Memory rows are loosely typed here because the existing JS code stuffs
// extra fields (deleted_at, etc.) into snapshots and we want to preserve
// behavior exactly. Tightening to `Memory` from @librarian/core/schemas is a
// follow-up after T3.3 has settled the canonical shape.
type MemoryRecord = Record<string, unknown> & { id: string };

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
        id, title, body, category, visibility, agent_id, actor_kind, scope, project_key,
        status, priority, confidence, tags_json, applies_to_json, supersedes_json,
        conflicts_with_json, created_at, updated_at, last_recalled_at, recall_count,
        usefulness_score, curator_note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = db.prepare(
      "INSERT INTO memories_fts (id, title, body, category, tags) VALUES (?, ?, ?, ?, ?)",
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
        m.category as string,
        m.visibility as string,
        (m.agent_id as string) || null,
        m.agent_id ? actorKind(m.agent_id as string) : null,
        m.scope as string,
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
      );
      insertFts.run(
        m.id as string,
        m.title as string,
        m.body as string,
        m.category as string,
        asArray(m.tags).join(" "),
      );
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

// ---------- Session side ----------

interface SessionLedgerEvent {
  event_id: string;
  event_type: SessionEventType;
  session_id: string | null;
  agent_id?: string | null;
  harness?: string | null;
  source_ref?: string | null;
  created_at: string;
  payload?: Record<string, unknown>;
}

interface SessionRow {
  id: string;
  title: string;
  project_key: string | null;
  status: string;
  prior_status: string | null;
  visibility: string;
  created_by_agent_id: string | null;
  current_agent_id: string | null;
  created_in_harness: string | null;
  current_harness: string | null;
  source_ref: string | null;
  cwd: string | null;
  start_summary: string | null;
  rolling_summary: string | null;
  end_summary: string | null;
  next_steps_json: string;
  tags_json: string;
  capture_mode: string;
  started_at: string;
  updated_at: string;
  last_activity_at: string;
  paused_at: string | null;
  ended_at: string | null;
  archived_at: string | null;
  deleted_at: string | null;
  metadata_json: string;
}

const SESSION_PATCH_COLUMNS = [
  "title",
  "project_key",
  "status",
  "prior_status",
  "visibility",
  "created_by_agent_id",
  "current_agent_id",
  "created_in_harness",
  "current_harness",
  "source_ref",
  "cwd",
  "start_summary",
  "rolling_summary",
  "end_summary",
  "next_steps_json",
  "tags_json",
  "capture_mode",
  "started_at",
  "updated_at",
  "last_activity_at",
  "paused_at",
  "ended_at",
  "archived_at",
  "deleted_at",
  "metadata_json",
] as const;

type SessionPatchColumn = (typeof SESSION_PATCH_COLUMNS)[number];

function getSessionRow(db: DatabaseSync, id: string): SessionRow | null {
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  return row ?? null;
}

function patchSessionRow(
  db: DatabaseSync,
  id: string,
  patch: Partial<Record<SessionPatchColumn, unknown>>,
): void {
  const setClauses: string[] = [];
  const params: unknown[] = [];
  for (const key of SESSION_PATCH_COLUMNS) {
    const value = patch[key];
    if (value !== undefined) {
      setClauses.push(`${key} = ?`);
      params.push(value);
    }
  }
  if (!setClauses.length) return;
  params.push(id);
  db.prepare(`UPDATE sessions SET ${setClauses.join(", ")} WHERE id = ?`).run(
    ...(params as never[]),
  );
}

interface SessionSnapshot {
  id: string;
  title: string;
  project_key?: string | null;
  status: string;
  prior_status?: string | null;
  visibility: string;
  created_by_agent_id?: string | null;
  current_agent_id?: string | null;
  created_in_harness?: string | null;
  current_harness?: string | null;
  source_ref?: string | null;
  cwd?: string | null;
  start_summary?: string | null;
  rolling_summary?: string | null;
  end_summary?: string | null;
  next_steps?: unknown;
  tags?: unknown;
  capture_mode: string;
  started_at: string;
  updated_at: string;
  last_activity_at: string;
  paused_at?: string | null;
  ended_at?: string | null;
  archived_at?: string | null;
  deleted_at?: string | null;
  metadata?: unknown;
}

function insertSessionRow(db: DatabaseSync, session: SessionSnapshot): void {
  // state_version seeds at 1 — startSession is itself the first
  // transition, so the first row update sets it explicitly rather than
  // relying on bumpStateVersion (which is called from update paths).
  db.prepare(
    `INSERT OR REPLACE INTO sessions (
      id, title, project_key, status, prior_status, visibility,
      created_by_agent_id, current_agent_id, created_in_harness, current_harness,
      source_ref, cwd, start_summary, rolling_summary, end_summary,
      next_steps_json, tags_json, capture_mode,
      started_at, updated_at, last_activity_at,
      paused_at, ended_at, archived_at, deleted_at, metadata_json, state_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    session.id,
    session.title,
    session.project_key || null,
    session.status,
    session.prior_status || null,
    session.visibility,
    session.created_by_agent_id || null,
    session.current_agent_id || null,
    session.created_in_harness || null,
    session.current_harness || null,
    session.source_ref || null,
    session.cwd || null,
    session.start_summary || null,
    session.rolling_summary || null,
    session.end_summary || null,
    JSON.stringify(asArray(session.next_steps)),
    JSON.stringify(asArray(session.tags)),
    session.capture_mode,
    session.started_at,
    session.updated_at,
    session.last_activity_at,
    session.paused_at || null,
    session.ended_at || null,
    session.archived_at || null,
    session.deleted_at || null,
    JSON.stringify(session.metadata || {}),
    1,
  );
}

// R1 — bump the row's state_version and (when the status actually changed)
// append a row to session_state_changes. The state-change ledger only
// records true status transitions (active↔paused, paused→active, *→ended,
// ended→paused). Checkpoints and event-recorded calls bump the version
// because they mutate the row, but skip the audit insert.
function bumpStateVersion(db: DatabaseSync, sessionId: string): void {
  db.prepare(`UPDATE sessions SET state_version = state_version + 1 WHERE id = ?`).run(sessionId);
}

function recordStateChange(
  db: DatabaseSync,
  sessionId: string,
  from: string | null,
  to: string,
  actorAgentId: string | null,
  at: string,
  note: string | null,
): void {
  db.prepare(
    `INSERT INTO session_state_changes (session_id, from_status, to_status, actor_agent_id, at, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, from, to, actorAgentId, at, note);
}

function insertSessionEventRow(
  db: DatabaseSync,
  event: SessionLedgerEvent,
  summary: string,
  type: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO session_events (
      id, session_id, type, agent_id, harness, source_ref, summary, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.event_id,
    event.session_id ?? "",
    type,
    event.agent_id || null,
    event.harness || null,
    event.source_ref || null,
    summary,
    JSON.stringify(event.payload || {}),
    event.created_at,
  );
  db.prepare(
    "INSERT INTO session_events_fts (event_id, session_id, summary, payload_text) VALUES (?, ?, ?, ?)",
  ).run(event.event_id, event.session_id ?? "", summary, JSON.stringify(event.payload || {}));
}

function eventSummary(event: SessionLedgerEvent): string {
  if (event.event_type === SessionEventType.Started) {
    const session = event.payload?.session as SessionSnapshot | undefined;
    return session?.start_summary || session?.title || "Session started.";
  }
  return event.event_type;
}

function shortType(eventType: SessionEventType): string {
  return eventType.startsWith("session.") ? eventType.slice("session.".length) : eventType;
}

/**
 * Apply a single session ledger event to the SQLite projection. Idempotent
 * by `event.event_id` thanks to INSERT OR REPLACE on session_events.
 */
export function applySessionEvent(db: DatabaseSync, event: SessionLedgerEvent): void {
  const type = event.event_type;
  const payload = (event.payload || {}) as Record<string, unknown>;
  const sessionId = event.session_id;

  if (type === SessionEventType.Started) {
    const session = payload.session as SessionSnapshot | undefined;
    if (!session) return;
    insertSessionRow(db, session);
    insertSessionEventRow(db, event, eventSummary(event), shortType(type));
    recordStateChange(
      db,
      session.id,
      null,
      session.status,
      (payload.agent_id as string) || session.created_by_agent_id || null,
      event.created_at,
      (session.start_summary as string) || null,
    );
    return;
  }

  if (!sessionId) return;
  const existing = getSessionRow(db, sessionId);
  if (!existing) return;

  if (type === SessionEventType.AttachedToHarness) {
    // S1.1: attaching to an ended session resumes the lifecycle. Status
    // returns to `paused`; the next `record_session_event` flips it to
    // `active` via the EventRecorded handler below.
    const updates: Partial<Record<SessionPatchColumn, unknown>> = {
      current_agent_id: (payload.agent_id as string) || existing.current_agent_id,
      current_harness: (payload.harness as string) ?? existing.current_harness,
      source_ref: (payload.source_ref as string) ?? existing.source_ref,
      cwd: (payload.cwd as string) ?? existing.cwd,
      last_activity_at: event.created_at,
      updated_at: event.created_at,
    };
    const wasEnded = existing.status === SessionStatus.Ended;
    if (wasEnded) {
      updates.status = SessionStatus.Paused;
      updates.ended_at = null;
    }
    patchSessionRow(db, existing.id, updates);
    bumpStateVersion(db, existing.id);
    if (wasEnded) {
      recordStateChange(
        db,
        existing.id,
        SessionStatus.Ended,
        SessionStatus.Paused,
        (payload.agent_id as string) || existing.current_agent_id,
        event.created_at,
        `Attached to ${(payload.harness as string) || "unknown harness"}.`,
      );
    }
    insertSessionEventRow(
      db,
      event,
      `Attached to ${(payload.harness as string) || "unknown harness"}.`,
      shortType(type),
    );
    return;
  }

  if (type === SessionEventType.EventRecorded) {
    const payloadType = payload.type as string | undefined;
    const summary = (payload.summary as string) || "";
    // S1.1: recording an event on a paused or ended session flips the
    // status back to active. The lifecycle gate (`assertSessionMutable`)
    // already accepts both, so this is the projection side of that
    // contract — resuming work is always implicit.
    const shouldReactivate =
      existing.status === SessionStatus.Paused || existing.status === SessionStatus.Ended;
    const updates: Partial<Record<SessionPatchColumn, unknown>> = {
      last_activity_at: event.created_at,
      updated_at: event.created_at,
    };
    if (shouldReactivate) {
      updates.status = SessionStatus.Active;
      updates.paused_at = null;
      updates.ended_at = null;
    }
    patchSessionRow(db, existing.id, updates);
    bumpStateVersion(db, existing.id);
    if (shouldReactivate) {
      recordStateChange(
        db,
        existing.id,
        existing.status,
        SessionStatus.Active,
        (payload.agent_id as string) || existing.current_agent_id,
        event.created_at,
        summary || null,
      );
    }
    insertSessionEventRow(db, event, summary, payloadType ?? "event");
    return;
  }

  if (type === SessionEventType.Checkpointed) {
    const summary = (payload.summary as string) || "";
    const nextSteps = payload.next_steps;
    const updates: Partial<Record<SessionPatchColumn, unknown>> = {
      rolling_summary: summary || existing.rolling_summary,
      last_activity_at: event.created_at,
      updated_at: event.created_at,
    };
    const wasPaused = existing.status === SessionStatus.Paused;
    if (wasPaused) {
      updates.status = SessionStatus.Active;
      updates.paused_at = null;
    }
    if (Array.isArray(nextSteps) && nextSteps.length) {
      updates.next_steps_json = JSON.stringify(asArray(nextSteps));
    }
    patchSessionRow(db, existing.id, updates);
    bumpStateVersion(db, existing.id);
    if (wasPaused) {
      recordStateChange(
        db,
        existing.id,
        SessionStatus.Paused,
        SessionStatus.Active,
        (payload.agent_id as string) || existing.current_agent_id,
        event.created_at,
        summary || null,
      );
    }
    insertSessionEventRow(db, event, summary || "Checkpoint.", shortType(type));
    return;
  }

  if (type === SessionEventType.Paused) {
    const summary = (payload.summary as string) || "";
    const nextSteps = payload.next_steps;
    const updates: Partial<Record<SessionPatchColumn, unknown>> = {
      status: SessionStatus.Paused,
      rolling_summary: summary || existing.rolling_summary,
      paused_at: event.created_at,
      last_activity_at: event.created_at,
      updated_at: event.created_at,
    };
    if (Array.isArray(nextSteps) && nextSteps.length) {
      updates.next_steps_json = JSON.stringify(asArray(nextSteps));
    }
    patchSessionRow(db, existing.id, updates);
    bumpStateVersion(db, existing.id);
    if (existing.status !== SessionStatus.Paused) {
      recordStateChange(
        db,
        existing.id,
        existing.status,
        SessionStatus.Paused,
        (payload.agent_id as string) || existing.current_agent_id,
        event.created_at,
        summary || null,
      );
    }
    insertSessionEventRow(db, event, summary || "Session paused.", shortType(type));
    return;
  }

  if (type === SessionEventType.Ended) {
    const summary = (payload.summary as string) || "";
    const nextSteps = payload.next_steps;
    const updates: Partial<Record<SessionPatchColumn, unknown>> = {
      status: SessionStatus.Ended,
      end_summary: summary,
      ended_at: event.created_at,
      last_activity_at: event.created_at,
      updated_at: event.created_at,
    };
    if (Array.isArray(nextSteps) && nextSteps.length) {
      updates.next_steps_json = JSON.stringify(asArray(nextSteps));
    }
    patchSessionRow(db, existing.id, updates);
    bumpStateVersion(db, existing.id);
    if (existing.status !== SessionStatus.Ended) {
      recordStateChange(
        db,
        existing.id,
        existing.status,
        SessionStatus.Ended,
        (payload.agent_id as string) || existing.current_agent_id,
        event.created_at,
        summary || null,
      );
    }
    insertSessionEventRow(db, event, summary || "Session ended.", shortType(type));
    return;
  }

  if (type === SessionEventType.Archived) {
    // S1.1 collapsed `archived` into `ended`. The event variant stays for
    // historical replay; archived_at is preserved as an audit timestamp
    // but no new code emits `session.archived`.
    patchSessionRow(db, existing.id, {
      status: SessionStatus.Ended,
      archived_at: event.created_at,
      ended_at: existing.ended_at || event.created_at,
      last_activity_at: event.created_at,
      updated_at: event.created_at,
    });
    bumpStateVersion(db, existing.id);
    if (existing.status !== SessionStatus.Ended) {
      recordStateChange(
        db,
        existing.id,
        existing.status,
        SessionStatus.Ended,
        existing.current_agent_id,
        event.created_at,
        (payload.reason as string) || "Session archived.",
      );
    }
    insertSessionEventRow(
      db,
      event,
      (payload.reason as string) || "Session archived.",
      shortType(type),
    );
    return;
  }

  if (type === SessionEventType.Deleted) {
    // S1.1 also collapsed `deleted` into `ended`. Soft-delete is no longer
    // distinct from end; deleted_at is preserved for the audit trail.
    patchSessionRow(db, existing.id, {
      status: SessionStatus.Ended,
      deleted_at: event.created_at,
      ended_at: existing.ended_at || event.created_at,
      last_activity_at: event.created_at,
      updated_at: event.created_at,
    });
    bumpStateVersion(db, existing.id);
    if (existing.status !== SessionStatus.Ended) {
      recordStateChange(
        db,
        existing.id,
        existing.status,
        SessionStatus.Ended,
        existing.current_agent_id,
        event.created_at,
        (payload.reason as string) || "Session deleted.",
      );
    }
    insertSessionEventRow(
      db,
      event,
      (payload.reason as string) || "Session deleted.",
      shortType(type),
    );
    return;
  }

  if (type === SessionEventType.PromotedToMemory) {
    patchSessionRow(db, existing.id, {
      last_activity_at: event.created_at,
      updated_at: event.created_at,
    });
    bumpStateVersion(db, existing.id);
    const title = (payload.title as string) || "Promoted to memory.";
    insertSessionEventRow(db, event, title, shortType(type));
    return;
  }

  if (type === SessionEventType.Restored) {
    // S1.1 collapsed restore into resume: a `session.restored` event maps
    // to `status: paused` so the operator can pick it back up. Historical
    // event variant retained for replay; no new code emits it.
    patchSessionRow(db, existing.id, {
      status: SessionStatus.Paused,
      prior_status: null,
      archived_at: null,
      deleted_at: null,
      last_activity_at: event.created_at,
      updated_at: event.created_at,
    });
    bumpStateVersion(db, existing.id);
    if (existing.status !== SessionStatus.Paused) {
      recordStateChange(
        db,
        existing.id,
        existing.status,
        SessionStatus.Paused,
        existing.current_agent_id,
        event.created_at,
        "Restored to paused.",
      );
    }
    insertSessionEventRow(db, event, "Restored to paused.", shortType(type));
  }
}

/**
 * Full session-projection rebuild from the sessions JSONL ledger. Wipes the
 * sessions + session_events + state-changes + FTS tables and replays every
 * entry. Atomic via SQLite transaction.
 *
 * R3 — accepts an optional second ledger (`sessionsLegacyPath`) so the
 * pre-migration `sessions.jsonl` / `sessions.legacy.jsonl` can be merged
 * with the new `session_events.jsonl` on rebuild. Events from both
 * sources are sorted by `created_at` so historical state transitions land
 * in the correct order. The legacy ledger is read-only at runtime;
 * `appendSessionEvent` post-R3 only writes to `sessions.jsonl` for
 * timeline events.
 */
export function rebuildSessionIndex(
  db: DatabaseSync,
  sessionsPath: string,
  options: { sessionsLegacyPath?: string } = {},
): void {
  const timeline = readJsonl<SessionLedgerEvent>(sessionsPath);
  const legacy = options.sessionsLegacyPath
    ? readJsonl<SessionLedgerEvent>(options.sessionsLegacyPath)
    : [];
  // Merge by `created_at`. Both sources are append-only by time within
  // themselves; combining them keeps the natural ordering when the
  // operator has both files (post-migration) or just one (pre-migration
  // or fresh install).
  const events = [...legacy, ...timeline].sort((a, b) =>
    (a.created_at || "").localeCompare(b.created_at || ""),
  );

  // R3 — sessions table is SQLite-authoritative. Determine whether the
  // sessions row + state-changes audit need rebuilding by checking
  // whether the table is populated already. If it is, we only refresh
  // the timeline projection (`session_events` + FTS). If sessions is
  // empty, we replay everything (this is the pre-R1 → R3 first-boot
  // path where ensureSchema dropped the tables and we're rebuilding
  // from scratch).
  const existingSessions = (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number })
    .n;

  const tx = db.prepare("BEGIN");
  const commit = db.prepare("COMMIT");
  const rollback = db.prepare("ROLLBACK");
  tx.run();
  try {
    if (existingSessions === 0) {
      // Cold rebuild: sessions is empty, so every applySessionEvent
      // call inserts/updates as if the table started fresh.
      db.exec(
        "DELETE FROM session_state_changes; DELETE FROM session_events; DELETE FROM session_events_fts;",
      );
      for (const event of events) applySessionEvent(db, event);
    } else {
      // Warm rebuild: sessions data is canonical. Refresh ONLY the
      // timeline projection (`session_events` + FTS). We can't call
      // applySessionEvent because every handler would mutate the
      // sessions row (last_activity_at, state_version, etc.) which
      // post-R3 would double-count against the canonical state. The
      // legacy ledger is implicitly skipped because it carries only
      // state-transition events (post-migration); the new
      // session_events.jsonl is timeline-only and goes straight back
      // into the projection tables.
      db.exec("DELETE FROM session_events; DELETE FROM session_events_fts;");
      for (const event of events) {
        if (event.event_type !== SessionEventType.EventRecorded) continue;
        if (!event.session_id) continue;
        const payload = (event.payload || {}) as Record<string, unknown>;
        const summary = (payload.summary as string) || "";
        const type = (payload.type as string) || "event";
        insertSessionEventRow(db, event, summary, type);
      }
    }
    commit.run();
  } catch (error) {
    rollback.run();
    throw error;
  }
}

// Re-export jsonl helpers for convenience.
export { appendJsonl, readJsonl };

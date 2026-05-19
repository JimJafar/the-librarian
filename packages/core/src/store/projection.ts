// SQLite projection module — owns the schema and the rebuild + incremental
// insert paths for both memory and session ledgers.
//
// Public surface:
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
import { MemoryEventType, SessionEventType } from "../schemas/common.js";
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

export function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      category TEXT NOT NULL,
      visibility TEXT NOT NULL,
      agent_id TEXT,
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
      usefulness_score INTEGER NOT NULL
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
      created_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
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
      metadata_json TEXT NOT NULL
    );
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
    CREATE VIRTUAL TABLE IF NOT EXISTS session_events_fts USING fts5(
      event_id UNINDEXED,
      session_id,
      summary,
      payload_text
    );
  `);
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
          status: "active",
          updated_at: event.created_at,
        });
        break;
      case MemoryEventType.Rejected:
        memories.set(id, { ...existing, status: "rejected", updated_at: event.created_at });
        break;
      case MemoryEventType.Deleted:
        memories.set(id, {
          ...existing,
          status: "deleted",
          deleted_at: event.created_at,
          updated_at: event.created_at,
        });
        break;
      case MemoryEventType.Archived:
        memories.set(id, { ...existing, status: "archived", updated_at: event.created_at });
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
        const result = payload.result;
        const delta = result === "useful" ? 1 : result === "not_useful" ? -1 : -2;
        memories.set(id, {
          ...existing,
          usefulness_score: Number(existing.usefulness_score || 0) + delta,
          updated_at: event.created_at,
        });
        break;
      }
      case MemoryEventType.ConflictDetected: {
        const conflicts = new Set(asArray(existing.conflicts_with));
        for (const cid of asArray(payload.conflicts_with)) conflicts.add(cid);
        memories.set(id, {
          ...existing,
          status: existing.status === "proposed" ? "proposed" : "conflicted",
          conflicts_with: [...conflicts],
          updated_at: event.created_at,
        });
        break;
      }
      case MemoryEventType.ConflictResolved:
        memories.set(id, {
          ...existing,
          ...(payload.patch as Record<string, unknown>),
          status: (payload.status as string) || "active",
          updated_at: event.created_at,
        });
        break;
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
        id, title, body, category, visibility, agent_id, scope, project_key,
        status, priority, confidence, tags_json, applies_to_json, supersedes_json,
        conflicts_with_json, created_at, updated_at, last_recalled_at, recall_count, usefulness_score
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = db.prepare(
      "INSERT INTO memories_fts (id, title, body, category, tags) VALUES (?, ?, ?, ?, ?)",
    );
    const insertEvent = db.prepare(`
      INSERT INTO events (event_id, event_type, memory_id, agent_id, created_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?)
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
    .filter((m) => m.status !== "deleted" && m.status !== "rejected")
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
  db.prepare(
    `INSERT OR REPLACE INTO sessions (
      id, title, project_key, status, prior_status, visibility,
      created_by_agent_id, current_agent_id, created_in_harness, current_harness,
      source_ref, cwd, start_summary, rolling_summary, end_summary,
      next_steps_json, tags_json, capture_mode,
      started_at, updated_at, last_activity_at,
      paused_at, ended_at, archived_at, deleted_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  );
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
    return;
  }

  if (!sessionId) return;
  const existing = getSessionRow(db, sessionId);
  if (!existing) return;

  if (type === SessionEventType.AttachedToHarness) {
    patchSessionRow(db, existing.id, {
      current_agent_id: (payload.agent_id as string) || existing.current_agent_id,
      current_harness: (payload.harness as string) ?? existing.current_harness,
      source_ref: (payload.source_ref as string) ?? existing.source_ref,
      cwd: (payload.cwd as string) ?? existing.cwd,
      last_activity_at: event.created_at,
      updated_at: event.created_at,
    });
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
    const wasPaused = existing.status === "paused";
    const updates: Partial<Record<SessionPatchColumn, unknown>> = {
      last_activity_at: event.created_at,
      updated_at: event.created_at,
    };
    if (wasPaused) {
      updates.status = "active";
      updates.paused_at = null;
    }
    patchSessionRow(db, existing.id, updates);
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
    if (existing.status === "paused") {
      updates.status = "active";
      updates.paused_at = null;
    }
    if (Array.isArray(nextSteps) && nextSteps.length) {
      updates.next_steps_json = JSON.stringify(asArray(nextSteps));
    }
    patchSessionRow(db, existing.id, updates);
    insertSessionEventRow(db, event, summary || "Checkpoint.", shortType(type));
    return;
  }

  if (type === SessionEventType.Paused) {
    const summary = (payload.summary as string) || "";
    const nextSteps = payload.next_steps;
    const updates: Partial<Record<SessionPatchColumn, unknown>> = {
      status: "paused",
      rolling_summary: summary || existing.rolling_summary,
      paused_at: event.created_at,
      last_activity_at: event.created_at,
      updated_at: event.created_at,
    };
    if (Array.isArray(nextSteps) && nextSteps.length) {
      updates.next_steps_json = JSON.stringify(asArray(nextSteps));
    }
    patchSessionRow(db, existing.id, updates);
    insertSessionEventRow(db, event, summary || "Session paused.", shortType(type));
    return;
  }

  if (type === SessionEventType.Ended) {
    const summary = (payload.summary as string) || "";
    const nextSteps = payload.next_steps;
    const updates: Partial<Record<SessionPatchColumn, unknown>> = {
      status: "ended",
      end_summary: summary,
      ended_at: event.created_at,
      last_activity_at: event.created_at,
      updated_at: event.created_at,
    };
    if (Array.isArray(nextSteps) && nextSteps.length) {
      updates.next_steps_json = JSON.stringify(asArray(nextSteps));
    }
    patchSessionRow(db, existing.id, updates);
    insertSessionEventRow(db, event, summary || "Session ended.", shortType(type));
    return;
  }

  if (type === SessionEventType.Archived) {
    const updates: Partial<Record<SessionPatchColumn, unknown>> = {
      status: "archived",
      archived_at: event.created_at,
      last_activity_at: event.created_at,
      updated_at: event.created_at,
    };
    if (!["archived", "deleted"].includes(existing.status)) {
      updates.prior_status = existing.status;
    }
    patchSessionRow(db, existing.id, updates);
    insertSessionEventRow(
      db,
      event,
      (payload.reason as string) || "Session archived.",
      shortType(type),
    );
    return;
  }

  if (type === SessionEventType.Deleted) {
    const updates: Partial<Record<SessionPatchColumn, unknown>> = {
      status: "deleted",
      deleted_at: event.created_at,
      last_activity_at: event.created_at,
      updated_at: event.created_at,
    };
    if (!["archived", "deleted"].includes(existing.status)) {
      updates.prior_status = existing.status;
    }
    patchSessionRow(db, existing.id, updates);
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
    const title = (payload.title as string) || "Promoted to memory.";
    insertSessionEventRow(db, event, title, shortType(type));
    return;
  }

  if (type === SessionEventType.Restored) {
    const restoreTo = (payload.restore_to as string) || existing.prior_status || "paused";
    patchSessionRow(db, existing.id, {
      status: restoreTo,
      prior_status: null,
      archived_at: null,
      deleted_at: null,
      last_activity_at: event.created_at,
      updated_at: event.created_at,
    });
    insertSessionEventRow(db, event, `Restored to ${restoreTo}.`, shortType(type));
  }
}

/**
 * Full session-projection rebuild from the sessions JSONL ledger. Wipes the
 * sessions + session_events + FTS tables and replays every entry. Atomic
 * via SQLite transaction.
 */
export function rebuildSessionIndex(db: DatabaseSync, sessionsPath: string): void {
  const events = readJsonl<SessionLedgerEvent>(sessionsPath);

  const tx = db.prepare("BEGIN");
  const commit = db.prepare("COMMIT");
  const rollback = db.prepare("ROLLBACK");
  tx.run();
  try {
    db.exec("DELETE FROM sessions; DELETE FROM session_events; DELETE FROM session_events_fts;");
    for (const event of events) applySessionEvent(db, event);
    commit.run();
  } catch (error) {
    rollback.run();
    throw error;
  }
}

// Re-export jsonl helpers for convenience.
export { appendJsonl, readJsonl };

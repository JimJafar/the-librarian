// Slice-scoped memory evidence gathering for the memory curator (spec §9).
//
// A curation run operates on exactly one slice and must never read across a
// slice boundary (§3). This module turns a slice descriptor into a bounded,
// redacted, deterministically-ordered bundle of memory evidence:
//
//   - active + proposed memories for the slice (bodies redacted, §9/§10.4);
//   - archived memories as METADATA-ONLY tombstones (id/title/category/slice +
//     archive metadata + a normalized content fingerprint, NO body) so the
//     §10.3 pre-pass can block resurrection without re-exposing deleted content
//     (§9.1);
//   - caps + truncation so the bundle stays bounded and the prompt knows when
//     evidence was trimmed (§9 evidence caps).
//
// Reads are direct SELECTs against the SQLite projection (the read model) — this
// is read-only and never mutates memory. Session evidence is gathered separately.

import type { DatabaseSync } from "node:sqlite";
import { curationContentFingerprint, curationNormalizedTitle } from "./curator-fingerprint.js";
import { redactSecrets } from "./curator-redaction.js";
import { SessionPayloadType } from "./schemas/common.js";

export type SliceKind = "common_project" | "common_global" | "agent_private";

export interface EvidenceSlice {
  kind: SliceKind;
  /** Required for `common_project`. */
  projectKey?: string;
  /** Required for `agent_private`. */
  agentId?: string;
}

export interface MemoryEvidenceCaps {
  /** Max combined active + proposed + tombstone memories (active prioritised). */
  maxMemories: number;
  /** Max chars for a memory body before truncation. Default 4000. */
  maxBodyChars?: number;
}

export interface MemoryEvidenceItem {
  id: string;
  title: string; // redacted
  body: string; // redacted, possibly truncated
  category: string;
  scope: string;
  visibility: string;
  projectKey: string | null;
  agentId: string | null;
  status: "active" | "proposed";
  createdAt: string;
  updatedAt: string;
}

export interface TombstoneItem {
  id: string;
  title: string; // redacted
  category: string;
  scope: string;
  visibility: string;
  projectKey: string | null;
  agentId: string | null;
  archivedAt: string;
  archiveReason: string | null;
  /** sha256 of the normalized, redacted title+body — the resurrection key (§9.1). */
  contentFingerprint: string;
  /** Normalized, redacted title — the secondary resurrection key (§10.3). */
  normalizedTitle: string;
}

export interface MemoryEvidenceBundle {
  slice: EvidenceSlice;
  activeMemories: MemoryEvidenceItem[];
  proposedMemories: MemoryEvidenceItem[];
  tombstones: TombstoneItem[];
  /** True if the cap dropped any eligible memory or tombstone. */
  truncatedMemories: boolean;
  /** True if any body was trimmed to `maxBodyChars`. */
  truncatedFields: boolean;
  /** Count of secret occurrences scrubbed while gathering. */
  redactionCount: number;
}

const DEFAULT_MAX_BODY_CHARS = 4000;
const TRUNCATION_MARKER = " …[truncated]";
const ARCHIVE_EVENT_TYPES = ["memory.archived", "memory.deleted"]; // historical alias

interface MemoryRow {
  id: string;
  title: string;
  body: string;
  category: string;
  scope: string;
  visibility: string;
  project_key: string | null;
  agent_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface TombstoneRow extends MemoryRow {
  archive_payload: string | null;
  archived_at_event: string | null;
}

/** Running totals threaded through redaction/truncation so the bundle can report them. */
interface GatherStats {
  redactionCount: number;
  truncatedFields: boolean;
}

export function gatherMemoryEvidence(
  db: DatabaseSync,
  slice: EvidenceSlice,
  caps: MemoryEvidenceCaps,
): MemoryEvidenceBundle {
  const where = sliceWhere(slice);
  const maxBodyChars = caps.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  const stats: GatherStats = { redactionCount: 0, truncatedFields: false };

  // Fetch one past the budget per status so we can detect (not just apply) the cap.
  const limit = caps.maxMemories + 1;
  const activeRows = selectMemories(db, where, "active", limit);
  const proposedRows = selectMemories(db, where, "proposed", limit);
  const tombstoneRows = selectTombstones(db, where, limit);

  // Single budget consumed in priority order: active → proposed → tombstones (§9).
  let remaining = caps.maxMemories;
  const activeTaken = activeRows.slice(0, remaining);
  remaining -= activeTaken.length;
  const proposedTaken = proposedRows.slice(0, remaining);
  remaining -= proposedTaken.length;
  const tombstonesTaken = tombstoneRows.slice(0, remaining);

  const truncatedMemories =
    activeRows.length > activeTaken.length ||
    proposedRows.length > proposedTaken.length ||
    tombstoneRows.length > tombstonesTaken.length;

  return {
    slice,
    activeMemories: activeTaken.map((row) => toItem(row, "active", maxBodyChars, stats)),
    proposedMemories: proposedTaken.map((row) => toItem(row, "proposed", maxBodyChars, stats)),
    tombstones: tombstonesTaken.map((row) => toTombstone(row, stats)),
    truncatedMemories,
    truncatedFields: stats.truncatedFields,
    redactionCount: stats.redactionCount,
  };
}

interface SliceWhere {
  clause: string;
  params: string[];
}

// `agentColumn` is an internal constant ("agent_id" for memories,
// "created_by_agent_id" for sessions) — never user input, so interpolating it is
// safe. Slice values (projectKey/agentId) are always bound, never interpolated.
function sliceWhere(slice: EvidenceSlice, agentColumn = "agent_id"): SliceWhere {
  switch (slice.kind) {
    case "common_project":
      if (!slice.projectKey) throw new Error("common_project slice requires a projectKey");
      return { clause: "visibility = 'common' AND project_key = ?", params: [slice.projectKey] };
    case "common_global":
      // The true complement of common_project: every common memory with no
      // owning project. Partitioning on project_key (set → common_project,
      // null → common_global) guarantees each common memory is curated in
      // exactly ONE slice — no cross-slice double-exposure. This is a catch-all
      // for all project-less common scopes (global/environment/tool/session),
      // not only scope='global'. (Spec §9 says "global scope or null project";
      // we drop the scope arm because a global-scope memory that still carries a
      // project_key belongs to that project's slice, not the global run.)
      return { clause: "visibility = 'common' AND project_key IS NULL", params: [] };
    case "agent_private":
      if (!slice.agentId) throw new Error("agent_private slice requires an agentId");
      return {
        clause: `visibility = 'agent_private' AND ${agentColumn} = ?`,
        params: [slice.agentId],
      };
  }
}

function selectMemories(
  db: DatabaseSync,
  where: SliceWhere,
  status: "active" | "proposed",
  limit: number,
): MemoryRow[] {
  return db
    .prepare(
      `SELECT id, title, body, category, scope, visibility, project_key, agent_id, status,
              created_at, updated_at
       FROM memories
       WHERE ${where.clause} AND status = ?
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(...where.params, status, limit) as unknown as MemoryRow[];
}

function selectTombstones(db: DatabaseSync, where: SliceWhere, limit: number): TombstoneRow[] {
  // Archive date + reason live in the events ledger, not on the memory row.
  const archiveFilter = ARCHIVE_EVENT_TYPES.map(() => "?").join(", ");
  return (
    db
      .prepare(
        `SELECT m.id, m.title, m.body, m.category, m.scope, m.visibility, m.project_key, m.agent_id,
              m.status, m.created_at, m.updated_at,
              (SELECT e.payload_json FROM events e
                 WHERE e.memory_id = m.id AND e.event_type IN (${archiveFilter})
                 ORDER BY e.created_at DESC LIMIT 1) AS archive_payload,
              (SELECT e.created_at FROM events e
                 WHERE e.memory_id = m.id AND e.event_type IN (${archiveFilter})
                 ORDER BY e.created_at DESC LIMIT 1) AS archived_at_event
       FROM memories m
       WHERE ${where.clause} AND m.status = 'archived'
       ORDER BY m.updated_at DESC
       LIMIT ?`,
      )
      // Bind in textual placeholder order: the two archive subqueries sit in the
      // SELECT list (before the WHERE clause), so their event-type params come first.
      .all(
        ...ARCHIVE_EVENT_TYPES,
        ...ARCHIVE_EVENT_TYPES,
        ...where.params,
        limit,
      ) as unknown as TombstoneRow[]
  );
}

function toItem(
  row: MemoryRow,
  status: "active" | "proposed",
  maxBodyChars: number,
  stats: GatherStats,
): MemoryEvidenceItem {
  return {
    id: row.id,
    title: redact(row.title, stats),
    body: truncate(redact(row.body, stats), maxBodyChars, stats),
    category: row.category,
    scope: row.scope,
    visibility: row.visibility,
    projectKey: row.project_key,
    agentId: row.agent_id,
    status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTombstone(row: TombstoneRow, stats: GatherStats): TombstoneItem {
  // The body is fingerprinted (via the shared redact-then-fingerprint contract)
  // but NEVER emitted, so deleted content is not re-exposed (§9.1). Only the
  // emitted title is redacted here for display + the redaction tally.
  const redactedTitle = redact(row.title, stats);
  return {
    id: row.id,
    title: redactedTitle,
    category: row.category,
    scope: row.scope,
    visibility: row.visibility,
    projectKey: row.project_key,
    agentId: row.agent_id,
    archivedAt: row.archived_at_event ?? row.updated_at,
    archiveReason: parseArchiveReason(row.archive_payload),
    contentFingerprint: curationContentFingerprint(row.title, row.body),
    normalizedTitle: curationNormalizedTitle(row.title),
  };
}

function redact(value: string, stats: GatherStats): string {
  const { redacted, count } = redactSecrets(value);
  stats.redactionCount += count;
  return redacted;
}

function truncate(value: string, maxChars: number, stats: GatherStats): string {
  if (value.length <= maxChars) return value;
  stats.truncatedFields = true;
  return value.slice(0, maxChars) + TRUNCATION_MARKER;
}

function parseArchiveReason(payloadJson: string | null): string | null {
  if (!payloadJson) return null;
  try {
    const payload = JSON.parse(payloadJson) as { reason?: unknown };
    return typeof payload.reason === "string" ? payload.reason : null;
  } catch {
    return null;
  }
}

// ---------- Session evidence (spec §9) ----------

export interface SessionEvidenceCaps {
  maxSessions: number;
  /** Max evidence events per session. Default 30. */
  maxEventsPerSession?: number;
  /** Max chars for a summary / event / next-step before truncation. Default 4000. */
  maxSummaryChars?: number;
}

export interface SessionEventEvidence {
  type: string;
  summary: string; // redacted, possibly truncated
  createdAt: string;
}

export interface SessionEvidenceItem {
  id: string;
  title: string; // redacted
  status: string;
  projectKey: string | null;
  createdByAgentId: string | null;
  currentAgentId: string | null;
  startSummary: string | null; // redacted, truncated
  rollingSummary: string | null; // redacted, truncated
  endSummary: string | null; // redacted, truncated
  nextSteps: string[]; // redacted
  lastActivityAt: string;
  events: SessionEventEvidence[];
  /** True if this session's events were capped. */
  truncatedEvents: boolean;
}

export interface SessionEvidenceBundle {
  slice: EvidenceSlice;
  sessions: SessionEvidenceItem[];
  /** True if the session cap dropped any eligible session. */
  truncatedSessions: boolean;
  redactionCount: number;
}

const DEFAULT_MAX_EVENTS_PER_SESSION = 30;

interface SessionRow {
  id: string;
  title: string;
  status: string;
  project_key: string | null;
  created_by_agent_id: string | null;
  current_agent_id: string | null;
  start_summary: string | null;
  rolling_summary: string | null;
  end_summary: string | null;
  next_steps_json: string;
  last_activity_at: string;
}

interface SessionEventRow {
  type: string;
  summary: string;
  created_at: string;
}

export function gatherSessionEvidence(
  db: DatabaseSync,
  slice: EvidenceSlice,
  caps: SessionEvidenceCaps,
): SessionEvidenceBundle {
  // Sessions own their agent attribution under `created_by_agent_id`.
  const where = sliceWhere(slice, "created_by_agent_id");
  const maxChars = caps.maxSummaryChars ?? DEFAULT_MAX_BODY_CHARS;
  const maxEvents = caps.maxEventsPerSession ?? DEFAULT_MAX_EVENTS_PER_SESSION;
  const stats: GatherStats = { redactionCount: 0, truncatedFields: false };

  const rows = selectSessions(db, where, caps.maxSessions + 1);
  const taken = rows.slice(0, caps.maxSessions);

  return {
    slice,
    sessions: taken.map((row) => toSessionItem(db, row, maxEvents, maxChars, stats)),
    truncatedSessions: rows.length > taken.length,
    redactionCount: stats.redactionCount,
  };
}

function selectSessions(db: DatabaseSync, where: SliceWhere, limit: number): SessionRow[] {
  return db
    .prepare(
      `SELECT id, title, status, project_key, created_by_agent_id, current_agent_id,
              start_summary, rolling_summary, end_summary, next_steps_json, last_activity_at
       FROM sessions
       WHERE ${where.clause}
       ORDER BY last_activity_at DESC
       LIMIT ?`,
    )
    .all(...where.params, limit) as unknown as SessionRow[];
}

function selectSessionEvents(
  db: DatabaseSync,
  sessionId: string,
  limit: number,
): SessionEventRow[] {
  // Only typed evidence events (excludes lifecycle rows like started/paused),
  // decisions then notes (candidate facts) first, then the rest by recency (§9).
  const types = Object.values(SessionPayloadType);
  const placeholders = types.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT type, summary, created_at FROM session_events
       WHERE session_id = ? AND type IN (${placeholders})
       ORDER BY CASE type WHEN 'decision' THEN 0 WHEN 'note' THEN 1 ELSE 2 END, created_at DESC
       LIMIT ?`,
    )
    .all(sessionId, ...types, limit) as unknown as SessionEventRow[];
}

function toSessionItem(
  db: DatabaseSync,
  row: SessionRow,
  maxEvents: number,
  maxChars: number,
  stats: GatherStats,
): SessionEvidenceItem {
  const eventRows = selectSessionEvents(db, row.id, maxEvents + 1);
  const eventsTaken = eventRows.slice(0, maxEvents);
  return {
    id: row.id,
    title: redact(row.title, stats),
    status: row.status,
    projectKey: row.project_key,
    createdByAgentId: row.created_by_agent_id,
    currentAgentId: row.current_agent_id,
    startSummary: redactNullable(row.start_summary, maxChars, stats),
    rollingSummary: redactNullable(row.rolling_summary, maxChars, stats),
    endSummary: redactNullable(row.end_summary, maxChars, stats),
    nextSteps: parseStringArray(row.next_steps_json).map((step) => redact(step, stats)),
    lastActivityAt: row.last_activity_at,
    events: eventsTaken.map((event) => ({
      type: event.type,
      summary: truncate(redact(event.summary, stats), maxChars, stats),
      createdAt: event.created_at,
    })),
    truncatedEvents: eventRows.length > eventsTaken.length,
  };
}

function redactNullable(value: string | null, maxChars: number, stats: GatherStats): string | null {
  return value === null ? null : truncate(redact(value, stats), maxChars, stats);
}

function parseStringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

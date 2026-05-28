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
// is read-only and never mutates memory. The curator is memory-only after the
// sessions rethink (sessions-rethink-spec §12): there is no session evidence.

import type { DatabaseSync } from "node:sqlite";
import { curationContentFingerprint, curationNormalizedTitle } from "./curator-fingerprint.js";
import { redactSecrets } from "./curator-redaction.js";

export type SliceKind = "common_project" | "common_global" | "agent_private";

/**
 * Enumerate the candidate slices that have curatable content (§9): the common
 * global slice (project-less common), one common_project per distinct project,
 * and one agent_private per distinct owning agent. Drawn from memories
 * (active/proposed — archived-only slices have nothing to curate). The
 * scheduler then applies due-gating to this set.
 */
export function listCuratorSlices(db: DatabaseSync): EvidenceSlice[] {
  const slices: EvidenceSlice[] = [];

  // Section 4d.3 — `memories.visibility` is dropped; all memories are common
  // now. The curator's memory-side slicing degenerates to project_key alone;
  // the `agent_private` slice surfaces an agent's authored memories rather
  // than a privacy-gated set.
  const hasGlobal = db
    .prepare("SELECT 1 FROM memories WHERE status != 'archived' AND project_key IS NULL LIMIT 1")
    .get();
  if (hasGlobal) slices.push({ kind: "common_global" });

  for (const projectKey of distinctValues(db, [
    "SELECT DISTINCT project_key AS v FROM memories WHERE status != 'archived' AND project_key IS NOT NULL",
  ])) {
    slices.push({ kind: "common_project", projectKey });
  }

  // The `agent_private` slice was driven by the (now-retired) sessions
  // table after 4d.3 — memories no longer carry visibility, so no source
  // exists to enumerate. The slice kind survives in the type so any
  // historical agent_private run row still validates; new runs are
  // never enumerated here.

  return slices;
}

function distinctValues(db: DatabaseSync, queries: string[]): string[] {
  const values = new Set<string>();
  for (const query of queries) {
    for (const row of db.prepare(query).all() as unknown as { v: string | null }[]) {
      if (row.v) values.add(row.v);
    }
  }
  return [...values].sort();
}

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
  projectKey: string | null;
  agentId: string | null;
  status: "active" | "proposed";
  createdAt: string;
  updatedAt: string;
  // Section 4d.3 — the classifier-decided gate. The curator's apply
  // layer reads this to flag operations that touch a protected
  // memory; legacy category strings are gone.
  requiresApproval: boolean;
  isGlobal: boolean;
}

export interface TombstoneItem {
  id: string;
  title: string; // redacted
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
  project_key: string | null;
  agent_id: string | null;
  status: string;
  requires_approval: number;
  is_global: number;
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
  const where = sliceWhereForMemories(slice);
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

// Section 4d.3 — memories no longer carry `visibility`. The memory-side
// slicing collapses to project_key alone. `agent_private` selects rows by
// their owning agent.
function sliceWhereForMemories(slice: EvidenceSlice): SliceWhere {
  switch (slice.kind) {
    case "common_project":
      if (!slice.projectKey) throw new Error("common_project slice requires a projectKey");
      return { clause: "project_key = ?", params: [slice.projectKey] };
    case "common_global":
      return { clause: "project_key IS NULL", params: [] };
    case "agent_private":
      if (!slice.agentId) throw new Error("agent_private slice requires an agentId");
      return { clause: "agent_id = ?", params: [slice.agentId] };
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
      `SELECT id, title, body, project_key, agent_id, status, requires_approval, is_global,
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
        `SELECT m.id, m.title, m.body, m.project_key, m.agent_id, m.status,
              m.requires_approval, m.is_global, m.created_at, m.updated_at,
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
    projectKey: row.project_key,
    agentId: row.agent_id,
    status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    requiresApproval: row.requires_approval === 1,
    isGlobal: row.is_global === 1,
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

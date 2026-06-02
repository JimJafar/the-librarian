// SQLite-backed CuratorMemorySource (plan 036 Phase 4).
//
// The curator's memory-evidence reads against the SQLite projection (the read
// model) + the events ledger — extracted verbatim from curator-evidence when
// the source seam landed, so behaviour is unchanged on the SQLite backend. The
// markdown backend uses `createVaultCuratorMemorySource` instead; this module
// retires with SQLite at the end of Phase 4.
//
// Reads are direct SELECTs and never mutate memory.

import type { DatabaseSync } from "node:sqlite";
import type {
  CuratorMemoryRecord,
  CuratorMemorySource,
  CuratorTombstoneRecord,
  EvidenceSlice,
} from "./curator-evidence.js";

interface SliceWhere {
  clause: string;
  params: string[];
}

// Section 4d.3 — memories no longer carry `visibility`. The memory-side slicing
// collapses to project_key alone; `agent_private` selects rows by owning agent.
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

const ARCHIVE_EVENT_TYPES = ["memory.archived", "memory.deleted"]; // historical alias

function parseArchiveReason(payloadJson: string | null): string | null {
  if (!payloadJson) return null;
  try {
    const payload = JSON.parse(payloadJson) as { reason?: unknown };
    return typeof payload.reason === "string" ? payload.reason : null;
  } catch {
    return null;
  }
}

function toRecord(row: MemoryRow): CuratorMemoryRecord {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    projectKey: row.project_key,
    agentId: row.agent_id,
    requiresApproval: row.requires_approval === 1,
    isGlobal: row.is_global === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createSqliteCuratorMemorySource(db: DatabaseSync): CuratorMemorySource {
  function listSlices(): EvidenceSlice[] {
    const slices: EvidenceSlice[] = [];

    // Section 4d.3 — `memories.visibility` is dropped; all memories are common
    // now. The curator's memory-side slicing degenerates to project_key alone.
    const hasGlobal = db
      .prepare("SELECT 1 FROM memories WHERE status != 'archived' AND project_key IS NULL LIMIT 1")
      .get();
    if (hasGlobal) slices.push({ kind: "common_global" });

    const projectKeys = new Set<string>();
    for (const row of db
      .prepare(
        "SELECT DISTINCT project_key AS v FROM memories WHERE status != 'archived' AND project_key IS NOT NULL",
      )
      .all() as unknown as { v: string | null }[]) {
      if (row.v) projectKeys.add(row.v);
    }
    for (const projectKey of [...projectKeys].sort()) {
      slices.push({ kind: "common_project", projectKey });
    }

    // The `agent_private` slice was driven by the (now-retired) sessions table;
    // memories no longer carry visibility, so no source exists to enumerate it.
    return slices;
  }

  function selectMemories(
    slice: EvidenceSlice,
    status: "active" | "proposed",
    limit: number,
  ): CuratorMemoryRecord[] {
    const where = sliceWhereForMemories(slice);
    const rows = db
      .prepare(
        `SELECT id, title, body, project_key, agent_id, status, requires_approval, is_global,
                created_at, updated_at
         FROM memories
         WHERE ${where.clause} AND status = ?
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(...where.params, status, limit) as unknown as MemoryRow[];
    return rows.map(toRecord);
  }

  function selectTombstones(slice: EvidenceSlice, limit: number): CuratorTombstoneRecord[] {
    const where = sliceWhereForMemories(slice);
    // Archive date + reason live in the events ledger, not on the memory row.
    const archiveFilter = ARCHIVE_EVENT_TYPES.map(() => "?").join(", ");
    const rows = db
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
      ) as unknown as TombstoneRow[];
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      projectKey: row.project_key,
      agentId: row.agent_id,
      archivedAt: row.archived_at_event ?? row.updated_at,
      archiveReason: parseArchiveReason(row.archive_payload),
    }));
  }

  return { listSlices, selectMemories, selectTombstones };
}

// Markdown-vault-backed GroomingMemorySource (plan 036 Phase 4).
//
// Reads memory docs from the git vault (via the markdown memory store's
// `listAll`) and partitions them into curator slices. Slice semantics
// (project-key-only, rethink D8):
//   - common_project → exact `project_key` match;
//   - common_global  → `project_key` IS NULL (project-less).
// Active/proposed feed slice enumeration + evidence; archived feed tombstones.
//
// The event ledger is retired on markdown, so a tombstone's `archiveReason` is
// null and `archivedAt` is the doc's `updatedAt` (which equals archive time —
// archiveMemory stamps updated_at when it flips status).
//
// The curator runs infrequently over a small corpus, so each public call reads
// the vault afresh (consistent with out-of-band vault edits) rather than caching.

import type {
  GroomingMemoryRecord,
  GroomingMemorySource,
  GroomingTombstoneRecord,
  EvidenceSlice,
} from "./grooming-evidence.js";
import { MemoryStatus } from "./schemas/common.js";
import type { Memory } from "./store/memory-store.js";

/** The minimal memory read surface the vault curator source needs. */
export interface GroomingVaultMemoryReader {
  listAll(filters?: Record<string, unknown>): Memory[];
}

function sliceMatches(slice: EvidenceSlice, memory: Memory): boolean {
  switch (slice.kind) {
    case "common_project":
      return (memory.project_key ?? null) === slice.projectKey;
    case "common_global":
      return memory.project_key == null;
  }
}

// updated_at DESC, with id DESC as a deterministic tiebreak. The curator's
// input hash is set-based (it sorts the evidence ids before hashing —
// curator-worker.ts), so this only decides which record survives the
// maxMemories cap on an exact updated_at tie at the boundary. It buys the vault's
// own run-to-run determinism.
function byUpdatedDesc(a: Memory, b: Memory): number {
  if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function toRecord(memory: Memory): GroomingMemoryRecord {
  return {
    id: memory.id,
    title: String(memory.title ?? ""),
    body: String(memory.body ?? ""),
    projectKey: memory.project_key ?? null,
    agentId: memory.agent_id ?? null,
    requiresApproval: memory.requires_approval === true,
    isGlobal: memory.is_global === true,
    createdAt: String(memory.created_at ?? memory.updated_at),
    updatedAt: String(memory.updated_at),
  };
}

function toTombstoneRecord(memory: Memory): GroomingTombstoneRecord {
  return {
    id: memory.id,
    title: String(memory.title ?? ""),
    body: String(memory.body ?? ""),
    projectKey: memory.project_key ?? null,
    agentId: memory.agent_id ?? null,
    archivedAt: String(memory.updated_at),
    archiveReason: null,
  };
}

export function createVaultGroomingMemorySource(
  reader: GroomingVaultMemoryReader,
): GroomingMemorySource {
  function listSlices(): EvidenceSlice[] {
    const live = reader.listAll({}).filter((m) => m.status !== MemoryStatus.Archived);
    const slices: EvidenceSlice[] = [];
    if (live.some((m) => m.project_key == null)) slices.push({ kind: "common_global" });
    const projectKeys = new Set<string>();
    for (const m of live) {
      if (m.project_key != null) projectKeys.add(m.project_key);
    }
    for (const projectKey of [...projectKeys].sort()) {
      slices.push({ kind: "common_project", projectKey });
    }
    return slices;
  }

  // Read the vault, keep what `predicate` accepts, then newest-first + cap + map
  // — the shared shape of both evidence reads.
  function selectNewest<T>(
    predicate: (memory: Memory) => boolean,
    limit: number,
    map: (memory: Memory) => T,
  ): T[] {
    return reader.listAll({}).filter(predicate).sort(byUpdatedDesc).slice(0, limit).map(map);
  }

  function selectMemories(
    slice: EvidenceSlice,
    status: "active" | "proposed",
    limit: number,
  ): GroomingMemoryRecord[] {
    return selectNewest((m) => m.status === status && sliceMatches(slice, m), limit, toRecord);
  }

  function selectTombstones(slice: EvidenceSlice, limit: number): GroomingTombstoneRecord[] {
    return selectNewest(
      (m) => m.status === MemoryStatus.Archived && sliceMatches(slice, m),
      limit,
      toTombstoneRecord,
    );
  }

  return { listSlices, selectMemories, selectTombstones };
}

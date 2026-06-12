// Slice-scoped memory evidence gathering for the memory curator (spec §9).
//
// A curation run operates on exactly one slice and must never read across a
// slice boundary (§3). This module turns a slice descriptor into a bounded,
// redacted, deterministically-ordered bundle of memory evidence:
//
//   - active + proposed memories for the slice (bodies redacted, §9/§10.4);
//   - archived memories as METADATA-ONLY tombstones (id/title/slice + archive
//     metadata + a normalized content fingerprint, NO body) so the §10.3
//     pre-pass can block resurrection without re-exposing deleted content (§9.1);
//   - caps + truncation so the bundle stays bounded and the prompt knows when
//     evidence was trimmed (§9 evidence caps).
//
// The actual memory reads are delegated to a `GroomingMemorySource` (plan 036
// Phase 4) so this gather/redact/cap logic is storage-agnostic: the markdown
// vault provides one via `createVaultGroomingMemorySource`. This module never
// touches a storage handle — it is pure over the source. The curator is
// memory-only after the sessions rethink (sessions-rethink-spec §12): no
// session evidence.

import { curationContentFingerprint, curationNormalizedTitle } from "./grooming-fingerprint.js";
import { redactSecrets } from "./grooming-redaction.js";

export type SliceKind = "common_project" | "common_global" | "agent_private";

export interface EvidenceSlice {
  kind: SliceKind;
  /** Required for `common_project`. */
  projectKey?: string;
  /** Required for `agent_private`. */
  agentId?: string;
}

/**
 * A memory as a `GroomingMemorySource` returns it — backend-neutral and
 * PRE-redaction (gatherMemoryEvidence owns redaction + truncation). The source
 * hands back raw title/body; the emitted bundle is what gets redacted.
 */
export interface GroomingMemoryRecord {
  id: string;
  title: string;
  body: string;
  projectKey: string | null;
  agentId: string | null;
  requiresApproval: boolean;
  isGlobal: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * An archived memory as a `GroomingMemorySource` returns it. Carries the raw
 * title+body (for fingerprinting — never emitted) plus archive metadata.
 * `archiveReason` is null when the backend records none (the markdown vault
 * retires the event ledger, so reasons aren't persisted there).
 */
export interface GroomingTombstoneRecord {
  id: string;
  title: string;
  body: string;
  projectKey: string | null;
  agentId: string | null;
  archivedAt: string;
  archiveReason: string | null;
}

/**
 * The memory reads the curator's evidence gathering needs, abstracted over the
 * storage backend (plan 036 Phase 4). Implementations return records
 * newest-first (by `updatedAt`) and already capped at `limit`; slice filtering
 * (exact `projectKey`, project-less global, `agentId` for agent_private) lives
 * in the source so this module stays backend-neutral.
 */
export interface GroomingMemorySource {
  /** Slices with curatable (active|proposed) content; the scheduler due-gates them. */
  listSlices(): EvidenceSlice[];
  /** Active|proposed memories for the slice, newest-first, ≤ limit. */
  selectMemories(
    slice: EvidenceSlice,
    status: "active" | "proposed",
    limit: number,
  ): GroomingMemoryRecord[];
  /** Archived memories for the slice (with archive metadata), newest-first, ≤ limit. */
  selectTombstones(slice: EvidenceSlice, limit: number): GroomingTombstoneRecord[];
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
  // Section 4d.3 — the protected-memory gate (set by admin/curator).
  // The curator's apply layer reads this to flag operations that touch
  // a protected memory; legacy category strings are gone.
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

/** Running totals threaded through redaction/truncation so the bundle can report them. */
interface GatherStats {
  redactionCount: number;
  truncatedFields: boolean;
}

/**
 * Validate the slice descriptor independently of the source, so an invalid slice
 * throws even against an empty store (the source's per-record filter would never
 * run, and thus never fault, on an empty result set).
 */
function assertValidSlice(slice: EvidenceSlice): void {
  if (slice.kind === "common_project" && !slice.projectKey) {
    throw new Error("common_project slice requires a projectKey");
  }
  if (slice.kind === "agent_private" && !slice.agentId) {
    throw new Error("agent_private slice requires an agentId");
  }
}

export function gatherMemoryEvidence(
  source: GroomingMemorySource,
  slice: EvidenceSlice,
  caps: MemoryEvidenceCaps,
): MemoryEvidenceBundle {
  assertValidSlice(slice);
  const maxBodyChars = caps.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  const stats: GatherStats = { redactionCount: 0, truncatedFields: false };

  // Fetch one past the budget per status so we can detect (not just apply) the cap.
  const limit = caps.maxMemories + 1;
  const activeRows = source.selectMemories(slice, "active", limit);
  const proposedRows = source.selectMemories(slice, "proposed", limit);
  const tombstoneRows = source.selectTombstones(slice, limit);

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
    activeMemories: activeTaken.map((rec) => toItem(rec, "active", maxBodyChars, stats)),
    proposedMemories: proposedTaken.map((rec) => toItem(rec, "proposed", maxBodyChars, stats)),
    tombstones: tombstonesTaken.map((rec) => toTombstone(rec, stats)),
    truncatedMemories,
    truncatedFields: stats.truncatedFields,
    redactionCount: stats.redactionCount,
  };
}

function toItem(
  rec: GroomingMemoryRecord,
  status: "active" | "proposed",
  maxBodyChars: number,
  stats: GatherStats,
): MemoryEvidenceItem {
  return {
    id: rec.id,
    title: redact(rec.title, stats),
    body: truncate(redact(rec.body, stats), maxBodyChars, stats),
    projectKey: rec.projectKey,
    agentId: rec.agentId,
    status,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    requiresApproval: rec.requiresApproval,
    isGlobal: rec.isGlobal,
  };
}

function toTombstone(rec: GroomingTombstoneRecord, stats: GatherStats): TombstoneItem {
  // The body is fingerprinted (via the shared redact-then-fingerprint contract)
  // but NEVER emitted, so deleted content is not re-exposed (§9.1). Only the
  // emitted title is redacted here for display + the redaction tally.
  const redactedTitle = redact(rec.title, stats);
  return {
    id: rec.id,
    title: redactedTitle,
    projectKey: rec.projectKey,
    agentId: rec.agentId,
    archivedAt: rec.archivedAt,
    archiveReason: rec.archiveReason,
    contentFingerprint: curationContentFingerprint(rec.title, rec.body),
    normalizedTitle: curationNormalizedTitle(rec.title),
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

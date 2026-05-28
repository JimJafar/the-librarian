// Shared enums and primitive schemas used by both memory and session schemas.
//
// TS string enums are the single source of truth — their values are the
// wire-format strings that appear in JSONL ledgers, SQLite rows, and the
// MCP / HTTP surface. Each Zod schema is derived via `z.enum(EnumType)`,
// so adding a new variant means adding one enum member and the schema +
// type automatically widen. Consumers compare against `Category.Lessons`
// etc. rather than bare string literals so that renames + additions are
// type-checked.

import { z } from "zod";

// Section 4d.2 — the `Category` / `Scope` enums and the
// `PROTECTED_CATEGORIES` routing set were retired from memories. The
// classifier worker decides `requires_approval` + `is_global`; domain
// comes from conv_state; tags carry whatever organising signal a
// memory needs. Historical ledger events that carry `category` /
// `visibility` / `scope` on their memory snapshots still parse — the
// projection just ignores those fields.

// Sessions still carry visibility (common vs agent_private), and the
// session router gates on it for cross-agent handover. Memory-side
// usage was removed in 4d.2.
export const PROTECTED_CATEGORY_STRINGS: ReadonlySet<string> = new Set([
  "identity",
  "relationship",
]);

export enum Visibility {
  Common = "common",
  AgentPrivate = "agent_private",
}
export const VisibilitySchema = z.enum(Visibility);

// Three-state model post-V1.2. The reason a memory is archived
// (rejected proposal, outdated verify, explicit admin archive, superseded
// in a conflict resolution) lives in the events ledger via the originating
// event type — not in a separate enum value. Old ledger lines that emit
// `memory.deleted` / `memory.rejected` / `memory.conflict_resolved` still
// parse and project to `archived` via the projection handlers.
export enum MemoryStatus {
  Active = "active",
  Proposed = "proposed",
  Archived = "archived",
}
export const MemoryStatusSchema = z.enum(MemoryStatus);

export enum Priority {
  Low = "low",
  Normal = "normal",
  High = "high",
  Core = "core",
}
export const PrioritySchema = z.enum(Priority);

export enum Confidence {
  Tentative = "tentative",
  Working = "working",
  Strong = "strong",
}
export const ConfidenceSchema = z.enum(Confidence);

// Ledger event-type enums. These TS enums are the single source of truth
// for the wire-format strings that appear in events.jsonl. Consuming code
// compares `event_type` against `MemoryEventType.Created` rather than bare
// string literals; the Zod `*Schema` exports below are derived via
// `z.enum(EnumType)`.

export enum MemoryEventType {
  Created = "memory.created",
  Proposed = "memory.proposed",
  Updated = "memory.updated",
  Approved = "memory.approved",
  Rejected = "memory.rejected",
  Deleted = "memory.deleted",
  Archived = "memory.archived",
  Recalled = "memory.recalled",
  RecallEmpty = "memory.recall_empty",
  Verified = "memory.verified",
  // Synthesised by `scripts/replay-verify-outcomes.mjs` to backfill the
  // V1.1 usefulness-score semantics across an existing ledger. Carries a
  // clamped score delta plus a `source` tag for audit.
  UsefulnessAdjusted = "memory.usefulness_adjusted",
  // D1.1 — emitted once per memory by `bulkUpdateMemory` so the bulk-
  // re-home flow has an audit trail distinct from per-memory updates.
  // Enables a future `memories.bulkRevert(transaction_id)` per the
  // dashboard-redesign spec; D1.1 itself only writes these.
  BulkUpdated = "memory.bulk_updated",
  ConflictDetected = "memory.conflict_detected",
  ConflictResolved = "memory.conflict_resolved",
  // classifier-implementation Section 4a — emitted by the classifier
  // worker for every classification attempt (success, parse failure,
  // provider error, or max-retries giveup). The eval harness reads
  // these to drive agreement-rate reports. See spec §4.8.
  Classified = "memory.classified",
  // classifier-implementation Section 4c — emitted by the dashboard's
  // classifier-eval page every time the operator runs an evaluation.
  // Carries run parameters + summary stats so the dashboard's history
  // view can render the timeline. See spec §4.6.
  ClassifierEvaluationCompleted = "classifier.evaluation_completed",
}
export const MemoryEventTypeSchema = z.enum(MemoryEventType);

export enum VerifyResult {
  Useful = "useful",
  NotUseful = "not_useful",
  Outdated = "outdated",
}
export const VerifyResultSchema = z.enum(VerifyResult);

// ISO 8601 UTC timestamps as emitted by `new Date().toISOString()`.
export const IsoTimestampSchema = z.iso.datetime();

// Opaque prefixed ids generated via crypto.randomUUID(), e.g. `mem_<uuid>`,
// `ses_<uuid>`, `evt_<uuid>`. We treat them as strings for now; tightening to
// `${prefix}_<uuid>` patterns is a Phase 3+ refinement.
export const IdSchema = z.string().min(1);

// Default sentinel for "no agent attribution available."
export const DEFAULT_AGENT_ID = "unknown-agent";

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

export enum Category {
  Identity = "identity",
  Relationship = "relationship",
  Preferences = "preferences",
  Projects = "projects",
  Environment = "environment",
  Tools = "tools",
  Lessons = "lessons",
  People = "people",
  OpenThreads = "open_threads",
}
export const CategorySchema = z.enum(Category);

// Set of categories that route writes through the proposal workflow
// instead of going straight to `active`. Identity + relationship memories
// are owner-approved only.
export const PROTECTED_CATEGORIES: ReadonlySet<Category> = new Set([
  Category.Identity,
  Category.Relationship,
]);
export type ProtectedCategory = Category.Identity | Category.Relationship;

export enum Visibility {
  Common = "common",
  AgentPrivate = "agent_private",
}
export const VisibilitySchema = z.enum(Visibility);

export enum Scope {
  Global = "global",
  Project = "project",
  Environment = "environment",
  Tool = "tool",
  Session = "session",
}
export const ScopeSchema = z.enum(Scope);

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

export enum SessionStatus {
  Active = "active",
  Paused = "paused",
  Ended = "ended",
  Archived = "archived",
  Deleted = "deleted",
}
export const SessionStatusSchema = z.enum(SessionStatus);

export enum SessionCaptureMode {
  Off = "off",
  Summary = "summary",
  Log = "log",
}
export const SessionCaptureModeSchema = z.enum(SessionCaptureMode);

export enum SessionPayloadType {
  Message = "message",
  Command = "command",
  File = "file",
  Error = "error",
  Decision = "decision",
  Question = "question",
  Checkpoint = "checkpoint",
  Handover = "handover",
  Note = "note",
}
export const SessionPayloadTypeSchema = z.enum(SessionPayloadType);

// Ledger event-type enums. These TS enums are the single source of truth
// for the wire-format strings that appear in events.jsonl / sessions.jsonl.
// Consuming code compares `event_type` against `MemoryEventType.Created` /
// `SessionEventType.Paused` etc. rather than bare string literals; the Zod
// `*Schema` exports below are derived via `z.enum(EnumType)`, and each
// variant in events.ts uses `z.literal(MemoryEventType.X)` so the
// discriminated union still narrows correctly.

export enum SessionEventType {
  Started = "session.started",
  AttachedToHarness = "session.attached_to_harness",
  EventRecorded = "session.event_recorded",
  Checkpointed = "session.checkpointed",
  Paused = "session.paused",
  Ended = "session.ended",
  Archived = "session.archived",
  Restored = "session.restored",
  Deleted = "session.deleted",
  PromotedToMemory = "session.promoted_to_memory",
}
export const SessionEventTypeSchema = z.enum(SessionEventType);

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
  ConflictDetected = "memory.conflict_detected",
  ConflictResolved = "memory.conflict_resolved",
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

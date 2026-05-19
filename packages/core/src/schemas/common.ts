// Shared enums and primitive schemas used by both memory and session schemas.
//
// The `as const` arrays are the source of truth for the runtime values; the
// corresponding `*Schema` exports turn them into Zod enums whose inferred types
// are the narrow literal unions (not just `string`). When constants.js is
// ported to TS in T3.5, the duplicated arrays here collapse into the values
// these schemas already define.

import { z } from "zod";

export const CATEGORIES = [
  "identity",
  "relationship",
  "preferences",
  "projects",
  "environment",
  "tools",
  "lessons",
  "people",
  "open_threads",
] as const;
export const CategorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof CategorySchema>;

export const PROTECTED_CATEGORIES = ["identity", "relationship"] as const;
export type ProtectedCategory = (typeof PROTECTED_CATEGORIES)[number];

export const VISIBILITIES = ["common", "agent_private"] as const;
export const VisibilitySchema = z.enum(VISIBILITIES);
export type Visibility = z.infer<typeof VisibilitySchema>;

export const SCOPES = ["global", "project", "environment", "tool", "session"] as const;
export const ScopeSchema = z.enum(SCOPES);
export type Scope = z.infer<typeof ScopeSchema>;

export const MEMORY_STATUSES = [
  "active",
  "proposed",
  "conflicted",
  "archived",
  "deleted",
  "rejected",
] as const;
export const MemoryStatusSchema = z.enum(MEMORY_STATUSES);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

export const PRIORITIES = ["low", "normal", "high", "core"] as const;
export const PrioritySchema = z.enum(PRIORITIES);
export type Priority = z.infer<typeof PrioritySchema>;

export const CONFIDENCES = ["tentative", "working", "strong"] as const;
export const ConfidenceSchema = z.enum(CONFIDENCES);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const SESSION_STATUSES = ["active", "paused", "ended", "archived", "deleted"] as const;
export const SessionStatusSchema = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SESSION_CAPTURE_MODES = ["off", "summary", "log"] as const;
export const SessionCaptureModeSchema = z.enum(SESSION_CAPTURE_MODES);
export type SessionCaptureMode = z.infer<typeof SessionCaptureModeSchema>;

export const SESSION_PAYLOAD_TYPES = [
  "message",
  "command",
  "file",
  "error",
  "decision",
  "question",
  "checkpoint",
  "handover",
  "note",
] as const;
export const SessionPayloadTypeSchema = z.enum(SESSION_PAYLOAD_TYPES);
export type SessionPayloadType = z.infer<typeof SessionPayloadTypeSchema>;

export const SESSION_EVENT_TYPES = [
  "session.started",
  "session.attached_to_harness",
  "session.event_recorded",
  "session.checkpointed",
  "session.paused",
  "session.ended",
  "session.archived",
  "session.restored",
  "session.deleted",
  "session.promoted_to_memory",
] as const;
export const SessionEventTypeSchema = z.enum(SESSION_EVENT_TYPES);
export type SessionEventType = z.infer<typeof SessionEventTypeSchema>;

export const MEMORY_EVENT_TYPES = [
  "memory.created",
  "memory.proposed",
  "memory.updated",
  "memory.approved",
  "memory.rejected",
  "memory.deleted",
  "memory.archived",
  "memory.recalled",
  "memory.recall_empty",
  "memory.verified",
  "memory.conflict_detected",
  "memory.conflict_resolved",
] as const;
export const MemoryEventTypeSchema = z.enum(MEMORY_EVENT_TYPES);
export type MemoryEventType = z.infer<typeof MemoryEventTypeSchema>;

export const VERIFY_RESULTS = ["useful", "not_useful", "outdated"] as const;
export const VerifyResultSchema = z.enum(VERIFY_RESULTS);
export type VerifyResult = z.infer<typeof VerifyResultSchema>;

// ISO 8601 UTC timestamps as emitted by `new Date().toISOString()`.
export const IsoTimestampSchema = z.iso.datetime();

// Opaque prefixed ids generated via crypto.randomUUID(), e.g. `mem_<uuid>`,
// `ses_<uuid>`, `evt_<uuid>`. We treat them as strings for now; tightening to
// `${prefix}_<uuid>` patterns is a Phase 3+ refinement.
export const IdSchema = z.string().min(1);

// Default sentinel for "no agent attribution available."
export const DEFAULT_AGENT_ID = "unknown-agent";

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
// `PROTECTED_CATEGORIES` routing set were retired from memories.
// `requires_approval` + `is_global` are plain booleans set only by
// admin/curator (the classifier was deleted, rethink T4); tags carry
// whatever organising signal a memory needs (the conv_state-derived
// domain was retired with conv_state, rethink T2). Historical
// ledger events that carry `category` /
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

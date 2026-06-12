// Shared enums and primitive schemas used by the memory and handoff schemas.
//
// TS string enums are the single source of truth — their values are the
// wire-format strings that appear in vault frontmatter and on the
// MCP / HTTP surface. Each Zod schema is derived via `z.enum(EnumType)`,
// so adding a new variant means adding one enum member and the schema +
// type automatically widen. Consumers compare against `Priority.Core`
// etc. rather than bare string literals so that renames + additions are
// type-checked.

import { z } from "zod";

// Section 4d.2 — the `Category` / `Scope` enums and the
// `PROTECTED_CATEGORIES` routing set were retired from memories.
// `requires_approval` + `is_global` are plain booleans set only by
// admin/curator (the classifier was deleted, rethink T4); tags carry
// whatever organising signal a memory needs (the conv_state-derived
// domain was retired with conv_state, rethink T2). The `Visibility`
// enum was retired with the private-namespace split (rethink T9, D8) —
// curator slices are project-key-only.

// Three-state model post-V1.2. The reason a memory is archived
// (rejected proposal, explicit admin archive, superseded by a curator
// merge) lives in the git commit that archived it — not in a separate
// enum value.
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

// ISO 8601 UTC timestamps as emitted by `new Date().toISOString()`.
export const IsoTimestampSchema = z.iso.datetime();

// Opaque prefixed ids generated via crypto.randomUUID(), e.g. `mem_<uuid>`,
// `handoff_<uuid>`. We treat them as strings for now; tightening to
// `${prefix}_<uuid>` patterns is a Phase 3+ refinement.
export const IdSchema = z.string().min(1);

// Default sentinel for "no agent attribution available."
export const DEFAULT_AGENT_ID = "unknown-agent";

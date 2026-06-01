// Memory row schema — the canonical shape of a row in the `memories` SQLite
// table (after `rowToMemory` parses the JSON-encoded array columns) and the
// `payload.memory` snapshot embedded in JSONL ledger events.

import { z } from "zod";
import {
  ConfidenceSchema,
  IdSchema,
  IsoTimestampSchema,
  MemoryStatusSchema,
  PrioritySchema,
  VisibilitySchema,
} from "./common.js";

// Curator provenance attached to a memory (memory-curator spec §8). All fields
// optional so partial provenance (e.g. just run/operation ids on an auto-applied
// create) is valid; `supersedes` lists memory ids a correction is meant to replace.
export const CuratorNoteSchema = z.object({
  text: z.string().optional(),
  supersedes: z.array(z.string()).optional(),
  run_id: z.string().optional(),
  operation_id: z.string().optional(),
});
export type CuratorNote = z.infer<typeof CuratorNoteSchema>;

export const MemorySchema = z.object({
  id: IdSchema,
  title: z.string(),
  body: z.string(),
  // Section 4d.2 — `category` / `scope` are legacy free-text columns
  // preserved for historical events. New writes don't populate them;
  // the classifier worker is the source of truth for the policy
  // booleans. `visibility` stays optional because session promotion
  // still routes memories through `visibility=common`.
  category: z.string().optional(),
  visibility: VisibilitySchema.optional(),
  agent_id: z.string().nullable(),
  // Projection-derived (agent/admin/system/cli) via the resolver's `actorKind`;
  // never written by callers. Optional because the `payload.memory` snapshots
  // embedded in JSONL ledger events don't carry it — it lives only on the row.
  actor_kind: z.string().nullable().optional(),
  scope: z.string().optional(),
  project_key: z.string().nullable(),
  status: MemoryStatusSchema,
  priority: PrioritySchema,
  confidence: ConfidenceSchema,
  tags: z.array(z.string()),
  applies_to: z.array(z.string()),
  supersedes: z.array(z.string()),
  conflicts_with: z.array(z.string()),
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
  last_recalled_at: IsoTimestampSchema.nullable(),
  recall_count: z.number().int().nonnegative(),
  usefulness_score: z.number().int(),
  // Curator provenance + superseded reference (memory-curator spec §8). Set by
  // the curator's apply layer; null for agent/user-authored memories.
  curator_note: CuratorNoteSchema.nullable().optional(),
  // Classifier verdict booleans (optional on the schema; set by the worker).
  is_global: z.boolean().optional(),
  requires_approval: z.boolean().optional(),
});
export type Memory = z.infer<typeof MemorySchema>;

// Partial patches applied via `memory.updated` / `memory.approved` /
// `memory.conflict_resolved` ledger events. Field set mirrors the writable
// columns; `id`, `created_at`, and projection-only counters are excluded.
export const MemoryPatchSchema = MemorySchema.partial().omit({
  id: true,
  created_at: true,
  recall_count: true,
  usefulness_score: true,
  last_recalled_at: true,
  // Derived from agent_id on every rebuild — never patched directly.
  actor_kind: true,
  // Curator-only provenance — set via the trusted create/apply path, not
  // patchable over the wire (cleanPatch strips it; this keeps the contract honest).
  curator_note: true,
});
export type MemoryPatch = z.infer<typeof MemoryPatchSchema>;

// User-facing input accepted by `createMemory` and the various proposal flows.
// Currently lenient: fields beyond the documented set are tolerated (and
// dropped by `normalizeMemoryInput` in store.js). T3.3 tightens this when the
// memory-store module is extracted.
export const MemoryInputSchema = z.object({
  agent_id: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  content: z.string().optional(),
  // Section 4d.2 — `category` / `visibility` / `scope` are kept on
  // the input schema as opaque strings so legacy clients (tests,
  // historical CLI invocations) don't fail validation. They flow into
  // the projection but are no longer authoritative — the classifier
  // worker decides the policy booleans.
  category: z.string().optional(),
  visibility: z.string().optional(),
  scope: z.string().optional(),
  project_key: z.string().optional(),
  applies_to: z.array(z.string()).optional(),
  priority: PrioritySchema.optional(),
  confidence: ConfidenceSchema.optional(),
  tags: z.array(z.string()).optional(),
  status: MemoryStatusSchema.optional(),
});
export type MemoryInput = z.infer<typeof MemoryInputSchema>;

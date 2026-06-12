// Memory schema — the canonical shape of a memory document (frontmatter +
// body) as the markdown store reads and writes it.

import { z } from "zod";
import {
  ConfidenceSchema,
  IdSchema,
  IsoTimestampSchema,
  MemoryStatusSchema,
  PrioritySchema,
} from "./common.js";

// Curator provenance attached to a memory (memory-curator spec §8). All fields
// optional so partial provenance (e.g. just run/operation ids on an auto-applied
// create) is valid; `supersedes` lists memory ids a correction is meant to replace.
export const CuratorNoteSchema = z.object({
  text: z.string().optional(),
  supersedes: z.array(z.string()).optional(),
  run_id: z.string().optional(),
  operation_id: z.string().optional(),
  // The retired under-evaluation/dry-run tags (`addendum_version`, `dry_run`,
  // `dry_run_candidate` — rethink T9, D4) are no longer reserved here; the
  // non-strict parse tolerates them on existing vault docs.
});
export type CuratorNote = z.infer<typeof CuratorNoteSchema>;

export const MemorySchema = z.object({
  id: IdSchema,
  title: z.string(),
  body: z.string(),
  agent_id: z.string().nullable(),
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
  recall_count: z.number().int().nonnegative(),
  usefulness_score: z.number().int(),
  // Curator provenance + superseded reference (memory-curator spec §8). Set by
  // the curator's apply layer; null for agent/user-authored memories.
  curator_note: CuratorNoteSchema.nullable().optional(),
  // Routing booleans (optional on the schema; set by admin/curator only).
  is_global: z.boolean().optional(),
  requires_approval: z.boolean().optional(),
});
export type Memory = z.infer<typeof MemorySchema>;

// Partial patches accepted by `memories.update` and the proposal approve flow.
// Field set mirrors the writable fields; `id`, `created_at`, and store-derived
// counters are excluded.
export const MemoryPatchSchema = MemorySchema.partial().omit({
  id: true,
  created_at: true,
  recall_count: true,
  usefulness_score: true,
  // Curator-only provenance — set via the trusted create/apply path, not
  // patchable over the wire (cleanPatch strips it; this keeps the contract honest).
  curator_note: true,
});
export type MemoryPatch = z.infer<typeof MemoryPatchSchema>;

// User-facing input accepted by `createMemory` and the various proposal flows.
// Currently lenient: fields beyond the documented set are tolerated (Zod strips
// unknown keys, and `normalizeMemoryInput` drops anything it doesn't know).
export const MemoryInputSchema = z.object({
  agent_id: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  content: z.string().optional(),
  project_key: z.string().optional(),
  applies_to: z.array(z.string()).optional(),
  priority: PrioritySchema.optional(),
  confidence: ConfidenceSchema.optional(),
  tags: z.array(z.string()).optional(),
  status: MemoryStatusSchema.optional(),
});
export type MemoryInput = z.infer<typeof MemoryInputSchema>;

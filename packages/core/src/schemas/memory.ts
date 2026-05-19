// Memory row schema — the canonical shape of a row in the `memories` SQLite
// table (after `rowToMemory` parses the JSON-encoded array columns) and the
// `payload.memory` snapshot embedded in JSONL ledger events.

import { z } from "zod";
import {
  CategorySchema,
  ConfidenceSchema,
  IdSchema,
  IsoTimestampSchema,
  MemoryStatusSchema,
  PrioritySchema,
  ScopeSchema,
  VisibilitySchema,
} from "./common.js";

export const MemorySchema = z.object({
  id: IdSchema,
  title: z.string(),
  body: z.string(),
  category: CategorySchema,
  visibility: VisibilitySchema,
  agent_id: z.string().nullable(),
  scope: ScopeSchema,
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
  category: CategorySchema.optional(),
  visibility: VisibilitySchema.optional(),
  scope: ScopeSchema.optional(),
  project_key: z.string().optional(),
  applies_to: z.array(z.string()).optional(),
  priority: PrioritySchema.optional(),
  confidence: ConfidenceSchema.optional(),
  tags: z.array(z.string()).optional(),
  status: MemoryStatusSchema.optional(),
});
export type MemoryInput = z.infer<typeof MemoryInputSchema>;

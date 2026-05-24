// Curator LLM output parsing + schema validation (spec §10.5, structural half).
//
// The LLM response is UNTRUSTED. This layer parses the `{ operations: [...] }`
// envelope and strictly validates each operation against the CuratorOperation
// schema (§10.4). Strict objects REJECT any unexpected field — the guard against
// the model smuggling fields (e.g. a forged `curator_note`) past the prompt and
// into the apply layer. Validation is per-operation: valid ones are kept, the
// rest recorded as rejected (with their index + a reason) for audit, so one bad
// operation never discards the whole batch.
//
// Context-dependent checks — id membership, slice-boundary, secrets, empty/
// duplicate — are a separate pass (they need the evidence bundle). Risk
// classification and the apply policy (§11) follow.

import { z } from "zod";
import {
  CategorySchema,
  ConfidenceSchema,
  PrioritySchema,
  ScopeSchema,
  VisibilitySchema,
} from "./schemas/common.js";

// The curator's MemoryInput is a STRICT subset of memory fields (§10.4): no
// agent_id (ownership comes from the run slice, §11), no status, no curator_note.
const CuratorMemoryInputSchema = z.strictObject({
  title: z.string().min(1),
  body: z.string().min(1),
  category: CategorySchema,
  visibility: VisibilitySchema,
  scope: ScopeSchema,
  project_key: z.string().nullable().optional(),
  applies_to: z.array(z.string()).optional(),
  priority: PrioritySchema.optional(),
  confidence: ConfidenceSchema.optional(),
  tags: z.array(z.string()).optional(),
});

// A patch is a partial MemoryInput — every field optional, still strict.
const CuratorMemoryPatchSchema = z.strictObject({
  title: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
  category: CategorySchema.optional(),
  visibility: VisibilitySchema.optional(),
  scope: ScopeSchema.optional(),
  project_key: z.string().nullable().optional(),
  applies_to: z.array(z.string()).optional(),
  priority: PrioritySchema.optional(),
  confidence: ConfidenceSchema.optional(),
  tags: z.array(z.string()).optional(),
});

// Common to every operation: a non-empty rationale and an operation-confidence
// number in [0,1] (distinct from a memory's confidence ENUM above).
const rationale = z.string().min(1);
const confidence = z.number().min(0).max(1);

const NoopSchema = z.strictObject({
  type: z.literal("noop"),
  source_memory_ids: z.array(z.string()),
  rationale,
  confidence,
});
const ArchiveSchema = z.strictObject({
  type: z.literal("archive"),
  source_memory_ids: z.array(z.string()).min(1),
  source_session_ids: z.array(z.string()).optional(),
  rationale,
  confidence,
});
const UpdateSchema = z.strictObject({
  type: z.literal("update"),
  source_memory_id: z.string().min(1),
  patch: CuratorMemoryPatchSchema,
  rationale,
  confidence,
});
const MergeSchema = z.strictObject({
  type: z.literal("merge"),
  source_memory_ids: z.array(z.string()).min(2),
  replacement: CuratorMemoryInputSchema,
  rationale,
  confidence,
});
const SplitSchema = z.strictObject({
  type: z.literal("split"),
  source_memory_id: z.string().min(1),
  replacements: z.array(CuratorMemoryInputSchema).min(2),
  rationale,
  confidence,
});
const CreateSchema = z.strictObject({
  type: z.literal("create"),
  source_session_ids: z.array(z.string()),
  memory: CuratorMemoryInputSchema,
  rationale,
  confidence,
});

export const CuratorOperationSchema = z.discriminatedUnion("type", [
  NoopSchema,
  ArchiveSchema,
  UpdateSchema,
  MergeSchema,
  SplitSchema,
  CreateSchema,
]);

export type CuratorOperation = z.infer<typeof CuratorOperationSchema>;
export type CuratorMemoryInput = z.infer<typeof CuratorMemoryInputSchema>;
export type CuratorMemoryPatch = z.infer<typeof CuratorMemoryPatchSchema>;

export interface RejectedOperation {
  /** Index in the model's `operations` array. */
  index: number;
  /** Why the operation failed schema validation. */
  reason: string;
}

export interface ParsedCuratorOutput {
  operations: CuratorOperation[];
  rejected: RejectedOperation[];
  /** Set when the whole response was unusable (bad JSON or no operations array). */
  parseError?: string;
}

export function parseCuratorOutput(raw: string): ParsedCuratorOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    return { operations: [], rejected: [], parseError: "output was not valid JSON" };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.operations)) {
    return { operations: [], rejected: [], parseError: 'output missing an "operations" array' };
  }

  const operations: CuratorOperation[] = [];
  const rejected: RejectedOperation[] = [];
  parsed.operations.forEach((element, index) => {
    const result = CuratorOperationSchema.safeParse(element);
    if (result.success) operations.push(result.data);
    else rejected.push({ index, reason: summarizeIssues(result.error) });
  });
  return { operations, rejected };
}

// Some OpenAI-compatible providers ignore response_format and wrap JSON in a
// markdown fence; tolerate a single leading/trailing ``` block.
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/\n?```$/, "")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function summarizeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

// JSONL ledger entry schemas.
//
// The Librarian's source of truth is two append-only JSONL files:
//   - events.jsonl     — memory-domain events
//   - sessions.jsonl   — session-domain events
//
// Both share a common envelope (event_id, event_type, agent_id, created_at,
// payload). The schemas below model each `event_type` as a separate object
// schema and combine them with `z.discriminatedUnion` so consumers can match
// on `event_type` to narrow `payload` without manual casts.

import { z } from "zod";
import {
  IdSchema,
  IsoTimestampSchema,
  MemoryEventType,
  MemoryStatusSchema,
  SessionEventType,
  VerifyResultSchema,
} from "./common.js";
import { MemoryPatchSchema, MemorySchema } from "./memory.js";
import { SessionEventPayloadSchema, SessionSchema } from "./session.js";

// ---------- Memory ledger entries (events.jsonl) ----------

// Envelope shared by every memory ledger event. Exported so consumers can
// peek at `event_type` (or any envelope field) without parsing the full
// discriminated union — e.g., when scanning JSONL incrementally.
export const MemoryEventBaseSchema = z.object({
  event_id: IdSchema,
  memory_id: IdSchema.nullable(),
  agent_id: z.string().nullable(),
  created_at: IsoTimestampSchema,
});

export const MemoryCreatedEventSchema = MemoryEventBaseSchema.extend({
  event_type: z.literal(MemoryEventType.Created),
  payload: z.object({ memory: MemorySchema }),
});

export const MemoryProposedEventSchema = MemoryEventBaseSchema.extend({
  event_type: z.literal(MemoryEventType.Proposed),
  payload: z.object({ memory: MemorySchema }),
});

export const MemoryUpdatedEventSchema = MemoryEventBaseSchema.extend({
  event_type: z.literal(MemoryEventType.Updated),
  payload: z.object({
    memory_id: IdSchema,
    agent_id: z.string(),
    patch: MemoryPatchSchema,
  }),
});

export const MemoryApprovedEventSchema = MemoryEventBaseSchema.extend({
  event_type: z.literal(MemoryEventType.Approved),
  payload: z.object({
    memory_id: IdSchema,
    agent_id: z.string(),
    patch: MemoryPatchSchema.optional(),
  }),
});

export const MemoryRejectedEventSchema = MemoryEventBaseSchema.extend({
  event_type: z.literal(MemoryEventType.Rejected),
  payload: z.object({ memory_id: IdSchema, agent_id: z.string() }),
});

export const MemoryDeletedEventSchema = MemoryEventBaseSchema.extend({
  event_type: z.literal(MemoryEventType.Deleted),
  payload: z.object({ memory_id: IdSchema, agent_id: z.string() }),
});

export const MemoryArchivedEventSchema = MemoryEventBaseSchema.extend({
  event_type: z.literal(MemoryEventType.Archived),
  payload: z.object({ memory_id: IdSchema, agent_id: z.string() }),
});

export const MemoryRecalledEventSchema = MemoryEventBaseSchema.extend({
  event_type: z.literal(MemoryEventType.Recalled),
  payload: z.object({
    memory_ids: z.array(IdSchema),
    agent_id: z.string(),
    query: z.string().optional(),
    note: z.string().optional(),
  }),
});

export const MemoryRecallEmptyEventSchema = MemoryEventBaseSchema.extend({
  event_type: z.literal(MemoryEventType.RecallEmpty),
  payload: z.object({
    agent_id: z.string(),
    query: z.string().optional(),
    note: z.string().optional(),
  }),
});

export const MemoryVerifiedEventSchema = MemoryEventBaseSchema.extend({
  event_type: z.literal(MemoryEventType.Verified),
  payload: z.object({
    memory_id: IdSchema,
    agent_id: z.string(),
    result: VerifyResultSchema,
    note: z.string().optional(),
  }),
});

export const MemoryUsefulnessAdjustedEventSchema = MemoryEventBaseSchema.extend({
  event_type: z.literal(MemoryEventType.UsefulnessAdjusted),
  payload: z.object({
    memory_id: IdSchema,
    agent_id: z.string(),
    score_delta: z.number().int(),
    source: z.string().optional(),
  }),
});

// D1.1 — emitted once per memory by `bulkUpdateMemory`. Carries the
// `transaction_id` (a single per-call id, shared by every event in
// the same bulk-update) so a future `bulkRevert(transaction_id)` can
// find the set of affected memories without scanning the projection.
//
// The patch is intentionally narrowed to `{ agent_id?, project_key? }`
// — the runtime contract (store + tRPC) restricts bulk-update to those
// two fields, so the schema enforces the same narrowing at the ledger
// layer. A future producer (replay script, migration tool) writing a
// bulk-updated event with `{title, body, status}` in the patch would
// fail schema validation rather than silently rewrite the memory on
// rebuild.
export const MemoryBulkUpdatedPatchSchema = z
  .object({
    agent_id: z.string().min(1).optional(),
    project_key: z.string().min(1).optional(),
  })
  .refine(
    (p) => p.agent_id !== undefined || p.project_key !== undefined,
    "bulk-updated patch must contain at least one of agent_id or project_key",
  );

export const MemoryBulkUpdatedEventSchema = MemoryEventBaseSchema.extend({
  event_type: z.literal(MemoryEventType.BulkUpdated),
  payload: z.object({
    memory_id: IdSchema,
    agent_id: z.string(),
    patch: MemoryBulkUpdatedPatchSchema,
    transaction_id: z.string(),
  }),
});

export const MemoryConflictDetectedEventSchema = MemoryEventBaseSchema.extend({
  event_type: z.literal(MemoryEventType.ConflictDetected),
  payload: z.object({
    memory_id: IdSchema,
    agent_id: z.string(),
    conflicts_with: z.array(IdSchema),
  }),
});

export const MemoryConflictResolvedEventSchema = MemoryEventBaseSchema.extend({
  event_type: z.literal(MemoryEventType.ConflictResolved),
  payload: z.object({
    memory_id: IdSchema,
    agent_id: z.string(),
    patch: MemoryPatchSchema.optional(),
    status: MemoryStatusSchema.optional(),
  }),
});

// classifier-implementation §4.8. Emitted once per classification attempt
// by the async worker — every success, parse failure, provider error, and
// max-retries giveup. `raw_output` is the eval substrate (kept indefinitely);
// `parsed` is the verdict (null on parse failure); `fallback_used` is set
// when conservative defaults were imposed by the classifier rather than
// chosen by the model. `attempt_number` is 1-indexed and aligns with the
// `classification_attempts` counter on the memories row after the increment.
export const MemoryClassifiedEventSchema = MemoryEventBaseSchema.extend({
  event_type: z.literal(MemoryEventType.Classified),
  payload: z.object({
    memory_id: IdSchema,
    agent_id: z.string(),
    input: z.object({
      title: z.string(),
      body: z.string(),
      tags: z.array(z.string()),
    }),
    provider: z.enum(["local", "remote", "none"]),
    model: z.string(),
    model_quant: z.string().nullable().optional(),
    prompt_version: z.string(),
    raw_output: z.string(),
    parsed: z
      .strictObject({
        requires_approval: z.boolean(),
        is_global: z.boolean(),
      })
      .nullable(),
    fallback_used: z
      .union([
        z.literal(false),
        z.literal("timeout"),
        z.literal("parse"),
        z.literal("provider_unavailable"),
        z.literal("max_retries"),
      ])
      .optional(),
    queue_wait_ms: z.number().int().nonnegative(),
    inference_ms: z.number().int().nonnegative(),
    attempt_number: z.number().int().positive(),
  }),
});

export const MemoryLedgerEntrySchema = z.discriminatedUnion("event_type", [
  MemoryCreatedEventSchema,
  MemoryProposedEventSchema,
  MemoryUpdatedEventSchema,
  MemoryApprovedEventSchema,
  MemoryRejectedEventSchema,
  MemoryDeletedEventSchema,
  MemoryArchivedEventSchema,
  MemoryRecalledEventSchema,
  MemoryRecallEmptyEventSchema,
  MemoryVerifiedEventSchema,
  MemoryUsefulnessAdjustedEventSchema,
  MemoryBulkUpdatedEventSchema,
  MemoryConflictDetectedEventSchema,
  MemoryConflictResolvedEventSchema,
  MemoryClassifiedEventSchema,
]);
export type MemoryLedgerEntry = z.infer<typeof MemoryLedgerEntrySchema>;

// ---------- Session ledger entries (sessions.jsonl) ----------

// Envelope shared by every session ledger event. Exported for the same
// reason as MemoryEventBaseSchema — envelope-only parsing.
export const SessionEventBaseSchema = z.object({
  event_id: IdSchema,
  session_id: IdSchema,
  agent_id: z.string().nullable(),
  harness: z.string().nullable(),
  source_ref: z.string().nullable(),
  created_at: IsoTimestampSchema,
});

export const SessionStartedEventSchema = SessionEventBaseSchema.extend({
  event_type: z.literal(SessionEventType.Started),
  payload: z.object({ session: SessionSchema }),
});

export const SessionAttachedEventSchema = SessionEventBaseSchema.extend({
  event_type: z.literal(SessionEventType.AttachedToHarness),
  payload: z.object({
    session: SessionSchema.optional(),
    harness: z.string().optional(),
    source_ref: z.string().optional(),
    cwd: z.string().optional(),
  }),
});

export const SessionEventRecordedEntrySchema = SessionEventBaseSchema.extend({
  event_type: z.literal(SessionEventType.EventRecorded),
  payload: SessionEventPayloadSchema,
});

// Shared lifecycle payload for checkpoint/pause/end — they all stamp a
// summary plus the typical handover fields onto the session.
const SessionLifecyclePayloadSchema = z.object({
  summary: z.string().nullable().optional(),
  decisions: z.array(z.string()).optional(),
  files_touched: z.array(z.string()).optional(),
  commands_run: z.array(z.string()).optional(),
  open_questions: z.array(z.string()).optional(),
  next_steps: z.array(z.string()).optional(),
  session: SessionSchema.optional(),
});

export const SessionCheckpointedEventSchema = SessionEventBaseSchema.extend({
  event_type: z.literal(SessionEventType.Checkpointed),
  payload: SessionLifecyclePayloadSchema,
});

export const SessionPausedEventSchema = SessionEventBaseSchema.extend({
  event_type: z.literal(SessionEventType.Paused),
  payload: SessionLifecyclePayloadSchema,
});

export const SessionEndedEventSchema = SessionEventBaseSchema.extend({
  event_type: z.literal(SessionEventType.Ended),
  payload: SessionLifecyclePayloadSchema,
});

export const SessionArchivedEventSchema = SessionEventBaseSchema.extend({
  event_type: z.literal(SessionEventType.Archived),
  payload: z.object({
    reason: z.string().nullable().optional(),
    session: SessionSchema.optional(),
  }),
});

export const SessionRestoredEventSchema = SessionEventBaseSchema.extend({
  event_type: z.literal(SessionEventType.Restored),
  payload: z.object({
    prior_status: z.string().nullable().optional(),
    session: SessionSchema.optional(),
  }),
});

export const SessionDeletedEventSchema = SessionEventBaseSchema.extend({
  event_type: z.literal(SessionEventType.Deleted),
  payload: z.object({
    reason: z.string().nullable().optional(),
    session: SessionSchema.optional(),
  }),
});

export const SessionPromotedToMemoryEventSchema = SessionEventBaseSchema.extend({
  event_type: z.literal(SessionEventType.PromotedToMemory),
  payload: z.object({
    memory_id: IdSchema,
    fact: z.string().optional(),
    category: z.string().optional(),
    session: SessionSchema.optional(),
  }),
});

export const SessionLedgerEntrySchema = z.discriminatedUnion("event_type", [
  SessionStartedEventSchema,
  SessionAttachedEventSchema,
  SessionEventRecordedEntrySchema,
  SessionCheckpointedEventSchema,
  SessionPausedEventSchema,
  SessionEndedEventSchema,
  SessionArchivedEventSchema,
  SessionRestoredEventSchema,
  SessionDeletedEventSchema,
  SessionPromotedToMemoryEventSchema,
]);
export type SessionLedgerEntry = z.infer<typeof SessionLedgerEntrySchema>;

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
import { IdSchema, IsoTimestampSchema, MemoryStatusSchema, VerifyResultSchema } from "./common.js";
import { MemoryPatchSchema, MemorySchema } from "./memory.js";
import { SessionEventPayloadSchema, SessionSchema } from "./session.js";

// ---------- Memory ledger entries (events.jsonl) ----------

const memoryEventBase = {
  event_id: IdSchema,
  memory_id: IdSchema.nullable(),
  agent_id: z.string().nullable(),
  created_at: IsoTimestampSchema,
};

export const MemoryCreatedEventSchema = z.object({
  ...memoryEventBase,
  event_type: z.literal("memory.created"),
  payload: z.object({ memory: MemorySchema }),
});

export const MemoryProposedEventSchema = z.object({
  ...memoryEventBase,
  event_type: z.literal("memory.proposed"),
  payload: z.object({ memory: MemorySchema }),
});

export const MemoryUpdatedEventSchema = z.object({
  ...memoryEventBase,
  event_type: z.literal("memory.updated"),
  payload: z.object({
    memory_id: IdSchema,
    agent_id: z.string(),
    patch: MemoryPatchSchema,
  }),
});

export const MemoryApprovedEventSchema = z.object({
  ...memoryEventBase,
  event_type: z.literal("memory.approved"),
  payload: z.object({
    memory_id: IdSchema,
    agent_id: z.string(),
    patch: MemoryPatchSchema.optional(),
  }),
});

export const MemoryRejectedEventSchema = z.object({
  ...memoryEventBase,
  event_type: z.literal("memory.rejected"),
  payload: z.object({ memory_id: IdSchema, agent_id: z.string() }),
});

export const MemoryDeletedEventSchema = z.object({
  ...memoryEventBase,
  event_type: z.literal("memory.deleted"),
  payload: z.object({ memory_id: IdSchema, agent_id: z.string() }),
});

export const MemoryArchivedEventSchema = z.object({
  ...memoryEventBase,
  event_type: z.literal("memory.archived"),
  payload: z.object({ memory_id: IdSchema, agent_id: z.string() }),
});

export const MemoryRecalledEventSchema = z.object({
  ...memoryEventBase,
  event_type: z.literal("memory.recalled"),
  payload: z.object({
    memory_ids: z.array(IdSchema),
    agent_id: z.string(),
    query: z.string().optional(),
    note: z.string().optional(),
  }),
});

export const MemoryRecallEmptyEventSchema = z.object({
  ...memoryEventBase,
  event_type: z.literal("memory.recall_empty"),
  payload: z.object({
    agent_id: z.string(),
    query: z.string().optional(),
    note: z.string().optional(),
  }),
});

export const MemoryVerifiedEventSchema = z.object({
  ...memoryEventBase,
  event_type: z.literal("memory.verified"),
  payload: z.object({
    memory_id: IdSchema,
    agent_id: z.string(),
    result: VerifyResultSchema,
    note: z.string().optional(),
  }),
});

export const MemoryConflictDetectedEventSchema = z.object({
  ...memoryEventBase,
  event_type: z.literal("memory.conflict_detected"),
  payload: z.object({
    memory_id: IdSchema,
    agent_id: z.string(),
    conflicts_with: z.array(IdSchema),
  }),
});

export const MemoryConflictResolvedEventSchema = z.object({
  ...memoryEventBase,
  event_type: z.literal("memory.conflict_resolved"),
  payload: z.object({
    memory_id: IdSchema,
    agent_id: z.string(),
    patch: MemoryPatchSchema.optional(),
    status: MemoryStatusSchema.optional(),
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
  MemoryConflictDetectedEventSchema,
  MemoryConflictResolvedEventSchema,
]);
export type MemoryLedgerEntry = z.infer<typeof MemoryLedgerEntrySchema>;

// ---------- Session ledger entries (sessions.jsonl) ----------

const sessionEventBase = {
  event_id: IdSchema,
  session_id: IdSchema,
  agent_id: z.string().nullable(),
  harness: z.string().nullable(),
  source_ref: z.string().nullable(),
  created_at: IsoTimestampSchema,
};

export const SessionStartedEventSchema = z.object({
  ...sessionEventBase,
  event_type: z.literal("session.started"),
  payload: z.object({ session: SessionSchema }),
});

export const SessionAttachedEventSchema = z.object({
  ...sessionEventBase,
  event_type: z.literal("session.attached_to_harness"),
  payload: z.object({
    session: SessionSchema.optional(),
    harness: z.string().optional(),
    source_ref: z.string().optional(),
    cwd: z.string().optional(),
  }),
});

export const SessionEventRecordedEntrySchema = z.object({
  ...sessionEventBase,
  event_type: z.literal("session.event_recorded"),
  payload: SessionEventPayloadSchema,
});

// Shared lifecycle envelope for checkpoint/pause/end — they all stamp a
// summary plus the typical handover fields onto the session.
const lifecyclePayload = z.object({
  summary: z.string().nullable().optional(),
  decisions: z.array(z.string()).optional(),
  files_touched: z.array(z.string()).optional(),
  commands_run: z.array(z.string()).optional(),
  open_questions: z.array(z.string()).optional(),
  next_steps: z.array(z.string()).optional(),
  session: SessionSchema.optional(),
});

export const SessionCheckpointedEventSchema = z.object({
  ...sessionEventBase,
  event_type: z.literal("session.checkpointed"),
  payload: lifecyclePayload,
});

export const SessionPausedEventSchema = z.object({
  ...sessionEventBase,
  event_type: z.literal("session.paused"),
  payload: lifecyclePayload,
});

export const SessionEndedEventSchema = z.object({
  ...sessionEventBase,
  event_type: z.literal("session.ended"),
  payload: lifecyclePayload,
});

export const SessionArchivedEventSchema = z.object({
  ...sessionEventBase,
  event_type: z.literal("session.archived"),
  payload: z.object({
    reason: z.string().nullable().optional(),
    session: SessionSchema.optional(),
  }),
});

export const SessionRestoredEventSchema = z.object({
  ...sessionEventBase,
  event_type: z.literal("session.restored"),
  payload: z.object({
    prior_status: z.string().nullable().optional(),
    session: SessionSchema.optional(),
  }),
});

export const SessionDeletedEventSchema = z.object({
  ...sessionEventBase,
  event_type: z.literal("session.deleted"),
  payload: z.object({
    reason: z.string().nullable().optional(),
    session: SessionSchema.optional(),
  }),
});

export const SessionPromotedToMemoryEventSchema = z.object({
  ...sessionEventBase,
  event_type: z.literal("session.promoted_to_memory"),
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

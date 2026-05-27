// Session row schema — canonical shape of a row in the `sessions` SQLite
// table (after `rowToSession` parses JSON-encoded columns) and the
// `payload.session` snapshot embedded in `session.*` JSONL ledger events.
//
// SessionEventRow is the canonical shape of a row in the `session_events`
// table. BOTH typed evidence events (`session.event_recorded`, projected under
// their payload type — decision/command/file/…) AND lifecycle events
// (`session.checkpointed`, `session.paused`, … projected under their short type
// — checkpointed/paused/…) produce rows here; lifecycle events additionally
// update the session row. Consumers that want only evidence (e.g. the curator)
// must filter the `type` column to the SessionPayloadType set.

import { z } from "zod";
import {
  IdSchema,
  IsoTimestampSchema,
  SessionCaptureModeSchema,
  SessionPayloadTypeSchema,
  SessionStatusSchema,
  VisibilitySchema,
} from "./common.js";

export const SessionSchema = z.object({
  id: IdSchema,
  title: z.string(),
  project_key: z.string().nullable(),
  status: SessionStatusSchema,
  prior_status: SessionStatusSchema.nullable(),
  visibility: VisibilitySchema,
  created_by_agent_id: z.string().nullable(),
  current_agent_id: z.string().nullable(),
  created_in_harness: z.string().nullable(),
  current_harness: z.string().nullable(),
  source_ref: z.string().nullable(),
  cwd: z.string().nullable(),
  start_summary: z.string().nullable(),
  rolling_summary: z.string().nullable(),
  end_summary: z.string().nullable(),
  next_steps: z.array(z.string()),
  tags: z.array(z.string()),
  capture_mode: SessionCaptureModeSchema,
  started_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
  last_activity_at: IsoTimestampSchema,
  paused_at: IsoTimestampSchema.nullable(),
  ended_at: IsoTimestampSchema.nullable(),
  archived_at: IsoTimestampSchema.nullable(),
  deleted_at: IsoTimestampSchema.nullable(),
  metadata: z.record(z.string(), z.unknown()),
  // memory-domain-isolation PR 1 / T1.2 — sessions inherit a domain
  // from the conv_state at `start_session` time. Defaults to 'general'.
  // Optional on the schema while PR 1 keeps start_session unaware of
  // the new field; PR 3 (T3.3) sets it from conv_state.
  domain: z.string().optional(),
});
export type Session = z.infer<typeof SessionSchema>;

// The shared shape of every session-event payload (regardless of type):
//   { type, summary, agent_id, ...extra }
// `extra` is callsite-defined and tolerated as unknown for now.
export const SessionEventPayloadSchema = z
  .object({
    type: SessionPayloadTypeSchema,
    summary: z.string(),
    agent_id: z.string(),
  })
  .catchall(z.unknown());
export type SessionEventPayload = z.infer<typeof SessionEventPayloadSchema>;

// A row in the `session_events` table — the projection of every
// `session.event_recorded` ledger entry.
export const SessionEventRowSchema = z.object({
  id: IdSchema,
  session_id: IdSchema,
  type: SessionPayloadTypeSchema,
  agent_id: z.string().nullable(),
  harness: z.string().nullable(),
  source_ref: z.string().nullable(),
  summary: z.string(),
  payload: z.record(z.string(), z.unknown()),
  created_at: IsoTimestampSchema,
});
export type SessionEventRow = z.infer<typeof SessionEventRowSchema>;

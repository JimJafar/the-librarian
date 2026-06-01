// Conversation-state row schema — per-conversation runtime state that
// survives context compaction via the per-turn hook contract from
// memory-domain-isolation §4.8.
//
// A conv_state row is keyed by `conv_id` (harness-supplied: Claude Code
// passes `CLAUDE_SESSION_ID`, Hermes passes `<channel>:<thread>`, etc.)
// and carries the attached `session_id` and the `off_record` toggle. The
// registry is intentionally ephemeral — the canonical work artefact is
// still the Librarian session; conv_state is the connective tissue
// between a harness's notion of "this conversation" and the Librarian's
// session/memory surface. (D16 dropped the per-conversation `domain`.)

import { z } from "zod";
import { IdSchema, IsoTimestampSchema } from "./common.js";

export const ConversationStateSchema = z.object({
  conv_id: z.string().min(1),
  harness: z.string().min(1),
  session_id: IdSchema.nullable(),
  off_record: z.boolean(),
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
});
export type ConversationState = z.infer<typeof ConversationStateSchema>;

// Patch accepted by `conv_state.upsert`. Every field is optional on
// update; on first-create, `harness` is required to satisfy the NOT NULL
// column. The store enforces the create-time requirement.
export const ConversationStatePatchSchema = z.object({
  harness: z.string().min(1).optional(),
  session_id: IdSchema.nullable().optional(),
  off_record: z.boolean().optional(),
});
export type ConversationStatePatch = z.infer<typeof ConversationStatePatchSchema>;

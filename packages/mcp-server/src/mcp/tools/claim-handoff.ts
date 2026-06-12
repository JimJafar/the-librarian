// `claim_handoff` MCP tool (sessions-rethink spec §6.1).
//
// Atomic claim + read in a single transaction. On 404 the handoff was never
// stored; on 409 someone else claimed first and
// the error payload carries the existing claim so the caller can render
// "claimed by X at Y."

import {
  ClaimHandoffInputSchema,
  HandoffAlreadyClaimedError,
  HandoffNotFoundError,
} from "@librarian/core";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";

const claimHandoff: ToolDefinition = {
  name: "claim_handoff",
  description:
    "Take over work, step 2 (after `list_handoffs`): atomically claim a " +
    "handoff and receive its document to resume from. Claims race — 404 if " +
    "the id is unknown; 409 if another agent claimed first (the existing " +
    "claim is included so you can say who has it and since when).",
  inputSchema: {
    type: "object",
    required: ["handoff_id"],
    properties: {
      handoff_id: { type: "string", minLength: 1 },
      claiming_agent_id: { type: ["string", "null"] },
      claiming_harness: { type: ["string", "null"] },
      claiming_source_ref: { type: ["string", "null"] },
      claiming_cwd: { type: ["string", "null"] },
    },
  },
  handler(store, args) {
    const parsed = ClaimHandoffInputSchema.safeParse(args);
    if (!parsed.success) {
      return textResult(
        `claim_handoff rejected: ${parsed.error.issues[0]?.message ?? "invalid input"}`,
      );
    }
    try {
      const claimed = store.handoffs.claim(parsed.data);
      return textResult(JSON.stringify(claimed, null, 2));
    } catch (error) {
      if (error instanceof HandoffNotFoundError) {
        return textResult(
          JSON.stringify({ error: "not_found", handoff_id: parsed.data.handoff_id }),
        );
      }
      if (error instanceof HandoffAlreadyClaimedError) {
        return textResult(
          JSON.stringify({
            error: "already_claimed",
            handoff_id: error.handoffId,
            claimed_at: error.claimedAt,
            claimed_by: error.claimedBy,
          }),
        );
      }
      throw error;
    }
  },
};

export default claimHandoff;

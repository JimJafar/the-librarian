// `claim_handoff` MCP tool (sessions-rethink spec §6.1).
//
// Atomic claim + read in a single transaction. On 404 the row was never
// stored (or sits in another domain); on 409 someone else claimed first and
// the error payload carries the existing claim so the caller can render
// "claimed by X at Y."

import {
  ClaimHandoffInputSchema,
  HandoffAlreadyClaimedError,
  HandoffNotFoundError,
} from "@librarian/core";
import { resolveCallerDomain } from "../domain-resolution.js";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";

const claimHandoff: ToolDefinition = {
  name: "claim_handoff",
  description:
    "Atomically claim a handoff and return its document. Fails 404 if the id " +
    "is unknown; 409 if already claimed (the existing claim is included so the " +
    "caller can render it). Server-scoped by domain.",
  inputSchema: {
    type: "object",
    required: ["handoff_id"],
    properties: {
      handoff_id: { type: "string", minLength: 1 },
      claiming_agent_id: { type: ["string", "null"] },
      claiming_harness: { type: ["string", "null"] },
      claiming_source_ref: { type: ["string", "null"] },
      claiming_cwd: { type: ["string", "null"] },
      conv_id: { type: "string" },
    },
  },
  handler(store, args, context) {
    const parsed = ClaimHandoffInputSchema.safeParse(args);
    if (!parsed.success) {
      return textResult(
        `claim_handoff rejected: ${parsed.error.issues[0]?.message ?? "invalid input"}`,
      );
    }
    const convId = typeof args.conv_id === "string" ? args.conv_id : "";
    const { domain } = resolveCallerDomain(store, convId, context);
    const effectiveDomain = domain ?? "general";

    try {
      const claimed = store.handoffs.claim(parsed.data, { domain: effectiveDomain });
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

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
      handoff_id: {
        type: "string",
        minLength: 1,
        description: "The id of the handoff to claim, taken from a list_handoffs result.",
      },
      claiming_agent_id: {
        type: ["string", "null"],
        description:
          "Optional identity of the agent taking over, recorded on the claim so others see who has it.",
      },
      claiming_harness: {
        type: ["string", "null"],
        description: "Optional harness the takeover is happening in, recorded on the claim.",
      },
      claiming_source_ref: {
        type: ["string", "null"],
        description:
          "Optional stable reference to where the resumed work now lives — a conversation/run id, or a cwd-prefixed absolute path.",
      },
      claiming_cwd: {
        type: ["string", "null"],
        description: "Optional working directory the takeover is happening in.",
      },
    },
  },
  handler(store, args, context) {
    const parsed = ClaimHandoffInputSchema.safeParse(args);
    if (!parsed.success) {
      return textResult(
        `claim_handoff rejected: ${parsed.error.issues[0]?.message ?? "invalid input"}`,
      );
    }
    // Route across the principal's RECALL shelves (spec 062 review F): locate the handoff by id (an
    // un-gated read) on each recall shelf in router order, then claim through THAT shelf's per-call
    // gated view — so a member can claim a handoff that lives under their own shelf, not just the vault
    // root. A claim is a principal-attributed MUTATION, so it respects the shelf's `writable`: claiming
    // on a read-only shelf raises the typed ShelfNotWritableError (surfaced cleanly by the dispatch).
    // Default router → one shelf (the vault root) → byte-identical (getById finds it, claim proceeds).
    const shelves = store.vaultRouter.shelves(context.principal, "recall");
    const target = shelves.find(
      (shelf) => store.forShelf(shelf).handoffs.getById(parsed.data.handoff_id) != null,
    );
    if (!target) {
      return textResult(JSON.stringify({ error: "not_found", handoff_id: parsed.data.handoff_id }));
    }
    try {
      const claimed = store.forShelf(target, context.principal).handoffs.claim(parsed.data);
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

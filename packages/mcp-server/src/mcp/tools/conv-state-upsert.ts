import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";

const convStateUpsert: ToolDefinition = {
  name: "conv_state_upsert",
  description:
    "Create or update the conversation-state row for the supplied conv_id. " +
    "First-create requires both `harness` and `domain`; subsequent updates accept any subset of " +
    "the four mutable fields. Setting `session_id: null` explicitly clears the attached session.",
  inputSchema: {
    type: "object",
    required: ["conv_id"],
    properties: {
      conv_id: { type: "string" },
      harness: { type: "string" },
      domain: { type: "string" },
      session_id: { type: ["string", "null"] },
      off_record: { type: "boolean" },
    },
  },
  handler(store, args) {
    const convId = String(args.conv_id ?? "");
    if (!convId) return textResult("conv_state.upsert: conv_id is required.");
    const patch: Record<string, unknown> = {};
    if (typeof args.harness === "string") patch.harness = args.harness;
    if (typeof args.domain === "string") patch.domain = args.domain;
    if (args.session_id === null || typeof args.session_id === "string") {
      patch.session_id = args.session_id;
    }
    if (typeof args.off_record === "boolean") patch.off_record = args.off_record;
    try {
      const next = store.convState.upsert(convId, patch);
      return textResult(JSON.stringify(next, null, 2));
    } catch (error) {
      return textResult(
        `conv_state.upsert failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
};

export default convStateUpsert;

import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";

const convStateClear: ToolDefinition = {
  name: "conv_state_clear",
  description:
    "Delete the conversation-state row for the supplied conv_id. Safe to call when the row does " +
    "not exist; the operation is idempotent.",
  inputSchema: {
    type: "object",
    required: ["conv_id"],
    properties: {
      conv_id: { type: "string" },
    },
  },
  handler(store, args) {
    const convId = String(args.conv_id ?? "");
    if (!convId) return textResult("conv_state.clear: conv_id is required.");
    store.convState.clear(convId);
    return textResult(`Cleared conversation state for conv_id ${convId}.`);
  },
};

export default convStateClear;

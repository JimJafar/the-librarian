import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { requireString } from "./conv-state-shared.js";

const convStateClear: ToolDefinition = {
  name: "conv_state_clear",
  description:
    "Delete the conversation-state row for the supplied conv_id. Safe to call when the row does " +
    "not exist; the operation is idempotent.",
  inputSchema: {
    type: "object",
    required: ["conv_id"],
    additionalProperties: false,
    properties: {
      conv_id: { type: "string", minLength: 1, description: "Harness-supplied conv identifier." },
    },
  },
  handler(store, args) {
    const convId = requireString(args.conv_id, "conv_state.clear: conv_id is required.");
    store.convState.clear(convId);
    return textResult(`Cleared conversation state for conv_id ${convId}.`);
  },
};

export default convStateClear;

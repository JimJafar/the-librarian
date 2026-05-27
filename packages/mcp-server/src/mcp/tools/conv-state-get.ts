import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";

const convStateGet: ToolDefinition = {
  name: "conv_state_get",
  description:
    "Return the conversation-state row for the supplied conv_id, or report 'no state' if absent. " +
    "Hook code calls this on every turn to re-inject the canonical block from spec §4.9.",
  inputSchema: {
    type: "object",
    required: ["conv_id"],
    properties: {
      conv_id: { type: "string", description: "Harness-supplied conversation identifier." },
    },
  },
  handler(store, args) {
    const convId = String(args.conv_id ?? "");
    if (!convId) return textResult("conv_state.get: conv_id is required.");
    const state = store.convState.get(convId);
    if (!state) return textResult(`No conversation state for conv_id ${convId}.`);
    return textResult(JSON.stringify(state, null, 2));
  },
};

export default convStateGet;

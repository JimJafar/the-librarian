import { formatRecall } from "@librarian/core";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { scopeAgentArgs } from "../visibility.js";

const resolveConflict: ToolDefinition = {
  name: "resolve_conflict",
  description: "Resolve conflicts between non-protected memories.",
  adminOnly: true,
  inputSchema: {
    type: "object",
    required: ["memory_ids", "resolution"],
    properties: {
      agent_id: { type: "string" },
      memory_ids: { type: "array", items: { type: "string" } },
      resolution: { type: "string", enum: ["supersede", "keep_both", "archive", "edit"] },
      explanation: { type: "string" },
      patch: { type: "object" },
    },
  },
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    const memories = store.resolveConflict(scoped);
    return textResult(formatRecall(memories, "Conflict Resolution Applied"));
  },
};

export default resolveConflict;

import { DEFAULT_AGENT_ID } from "@librarian/core";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { scopeAgentArgs } from "../visibility.js";

const updateMemory: ToolDefinition = {
  name: "update_memory",
  description: "Edit a memory while preserving history.",
  inputSchema: {
    type: "object",
    required: ["memory_id", "patch"],
    properties: {
      agent_id: { type: "string" },
      memory_id: { type: "string" },
      patch: { type: "object" },
    },
  },
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    const memory = store.updateMemory(
      scoped.memory_id as string,
      (scoped.patch as Record<string, unknown>) || {},
      (scoped.agent_id as string) || DEFAULT_AGENT_ID,
    )!;
    return textResult(`Memory updated.\n\n${memory.title}: ${memory.body}`);
  },
};

export default updateMemory;

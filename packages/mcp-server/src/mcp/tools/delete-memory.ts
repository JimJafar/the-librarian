import { DEFAULT_AGENT_ID } from "@librarian/core";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { scopeAgentArgs } from "../visibility.js";

const deleteMemory: ToolDefinition = {
  name: "delete_memory",
  description: "Tombstone a memory.",
  adminOnly: true,
  inputSchema: {
    type: "object",
    required: ["memory_id"],
    properties: {
      agent_id: { type: "string" },
      memory_id: { type: "string" },
    },
  },
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    const memory = store.deleteMemory(
      scoped.memory_id as string,
      (scoped.agent_id as string) || DEFAULT_AGENT_ID,
    )!;
    return textResult(`Memory deleted.\n\n${memory.title}`);
  },
};

export default deleteMemory;

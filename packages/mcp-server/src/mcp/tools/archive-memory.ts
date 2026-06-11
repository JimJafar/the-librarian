import { DEFAULT_AGENT_ID } from "@librarian/core";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { scopeAgentArgs } from "../visibility.js";

const archiveMemory: ToolDefinition = {
  name: "archive_memory",
  description:
    "Archive a memory so it drops out of default recall. " +
    "Admin-only — an agent that believes a memory is wrong or stale should call " +
    "`flag_memory` to route it to review instead.",
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
    const memory = store.archiveMemory(
      scoped.memory_id as string,
      (scoped.agent_id as string) || DEFAULT_AGENT_ID,
    )!;
    return textResult(`Memory archived.\n\n${memory.title}`);
  },
};

export default archiveMemory;

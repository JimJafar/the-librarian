import { DEFAULT_AGENT_ID } from "@librarian/core";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { scopeAgentArgs } from "../visibility.js";

const verifyMemory: ToolDefinition = {
  name: "verify_memory",
  description: "Record whether a memory was useful, stale, wrong, or not useful.",
  inputSchema: {
    type: "object",
    required: ["memory_id", "result"],
    properties: {
      agent_id: { type: "string" },
      memory_id: { type: "string" },
      result: { type: "string", enum: ["useful", "not_useful", "outdated", "wrong"] },
      note: { type: "string" },
    },
  },
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    const memory = store.verifyMemory(
      scoped.memory_id as string,
      scoped.result as string,
      (scoped.note as string) || "",
      (scoped.agent_id as string) || DEFAULT_AGENT_ID,
    )!;
    return textResult(`Memory verification recorded.\n\n${memory.title}`);
  },
};

export default verifyMemory;

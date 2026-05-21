import { DEFAULT_AGENT_ID } from "@librarian/core";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { scopeAgentArgs } from "../visibility.js";

const verifyMemory: ToolDefinition = {
  name: "verify_memory",
  description:
    "Record a verdict against a memory after using it. " +
    "`useful` raises its recall rank, `not_useful` lowers it (both clamped to ±3), " +
    "`outdated` archives the memory so it drops out of default recall.",
  inputSchema: {
    type: "object",
    required: ["memory_id", "result"],
    properties: {
      agent_id: { type: "string" },
      memory_id: { type: "string" },
      result: { type: "string", enum: ["useful", "not_useful", "outdated"] },
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

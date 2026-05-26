import { DEFAULT_AGENT_ID, formatRecall } from "@librarian/core";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { scopeAgentArgs } from "../visibility.js";

const recall: ToolDefinition = {
  name: "recall",
  description:
    "Search memories by query and filters. Returns clean prose; pass " +
    "`include_ids: true` to prefix each result with its memory id so the " +
    "caller can verify it via `verify_memory`.",
  inputSchema: {
    type: "object",
    properties: {
      agent_id: { type: "string" },
      query: { type: "string" },
      categories: { type: "array", items: { type: "string" } },
      project_key: { type: "string" },
      include_private: { type: "boolean" },
      include_ids: { type: "boolean" },
      limit: { type: "number" },
    },
  },
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    const memories = store.searchMemories(scoped);
    store.recordRecall(
      memories,
      (scoped.agent_id as string) || DEFAULT_AGENT_ID,
      (scoped.query as string) || "",
    );
    const includeIds = scoped.include_ids === true;
    return textResult(formatRecall(memories, "Relevant Memories", { includeIds }));
  },
};

export default recall;

import { DEFAULT_AGENT_ID, formatRecall } from "@librarian/core";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { scopeAgentArgs } from "../visibility.js";

const recall: ToolDefinition = {
  name: "recall",
  description:
    "Search memories by query and tags. `tags` filters to memories carrying " +
    "any of the supplied tags. Pass `include_ids: true` to prefix each result " +
    "with its memory id for the verify-after-recall loop.",
  inputSchema: {
    type: "object",
    properties: {
      agent_id: { type: "string" },
      query: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      project_key: { type: "string" },
      include_ids: { type: "boolean" },
      limit: { type: "number" },
    },
  },
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    // conv_id was a domain-routing signal, not a search field.
    delete scoped.conv_id;
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

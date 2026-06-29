import { formatRecall } from "@librarian/core";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { scopeAgentArgs } from "../visibility.js";

const recall: ToolDefinition = {
  name: "recall",
  description:
    "Search the owner's durable memories. Call this before answering anything " +
    "that may have prior context — at task start, and whenever a stored fact, " +
    "preference, or past decision could change your answer. Memories only: " +
    "long-form reference docs are NOT here — search those with " +
    "`search_references`. Query by free text; `tags` narrows to memories " +
    "carrying any of the supplied tags. Pass `include_ids: true` to prefix " +
    "each result with its memory id, so a memory that turns out to be wrong " +
    "can be passed straight to `flag_memory`.",
  inputSchema: {
    type: "object",
    properties: {
      agent_id: {
        type: "string",
        description:
          "Server-populated from your authenticated token, not supplied by you — it identifies " +
          "the calling agent.",
      },
      query: {
        type: "string",
        description:
          "Free-text search over the owner's durable memories; matches are ranked by relevance.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Narrow the search to memories carrying any of these tags.",
      },
      include_ids: {
        type: "boolean",
        description:
          "When true, prefix each result with its memory id, so a memory that turns out to be " +
          "wrong can be passed straight to flag_memory.",
      },
      limit: { type: "number", description: "Maximum number of memories to return." },
    },
  },
  async handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    // conv_id was a domain-routing signal, not a search field.
    delete scoped.conv_id;
    // store.recall is index-backed (hybrid) on the markdown backend.
    const memories = await store.recall(scoped);
    const includeIds = scoped.include_ids === true;
    return textResult(formatRecall(memories, "Relevant Memories", { includeIds }));
  },
};

export default recall;

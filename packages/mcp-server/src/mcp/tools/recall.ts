import { DEFAULT_AGENT_ID, formatRecall } from "@librarian/core";
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
      agent_id: { type: "string" },
      query: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      include_ids: { type: "boolean" },
      limit: { type: "number" },
    },
  },
  async handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    // conv_id was a domain-routing signal, not a search field.
    delete scoped.conv_id;
    // store.recall is index-backed (hybrid) on the markdown backend.
    const memories = await store.recall(scoped);
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

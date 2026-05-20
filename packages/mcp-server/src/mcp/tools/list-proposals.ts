import { formatRecall } from "@librarian/core";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { listVisibleProposals, scopeAgentArgs } from "../visibility.js";

const listProposals: ToolDefinition = {
  name: "list_proposals",
  description: "List pending proposed memories.",
  inputSchema: {
    type: "object",
    properties: {
      agent_id: { type: "string" },
    },
  },
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    const proposals = listVisibleProposals(store, scoped, context.role);
    return textResult(formatRecall(proposals, "Pending Memory Proposals"));
  },
};

export default listProposals;

import { DEFAULT_AGENT_ID } from "@librarian/core";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { scopeAgentArgs } from "../visibility.js";

const approveProposal: ToolDefinition = {
  name: "approve_proposal",
  description: "Approve, edit, or reject a proposed memory.",
  adminOnly: true,
  inputSchema: {
    type: "object",
    required: ["memory_id"],
    properties: {
      agent_id: { type: "string" },
      memory_id: { type: "string" },
      action: { type: "string", enum: ["approve", "reject"] },
      patch: { type: "object" },
    },
  },
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    const action = (scoped.action as string) || "approve";
    const memory = store.approveProposal(
      scoped.memory_id as string,
      action,
      (scoped.patch as Record<string, unknown>) || {},
      (scoped.agent_id as string) || DEFAULT_AGENT_ID,
    )!;
    return textResult(
      `Proposal ${action === "reject" ? "rejected" : "approved"}.\n\n${memory.title}: ${memory.body}`,
    );
  },
};

export default approveProposal;

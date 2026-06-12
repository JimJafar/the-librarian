// `store_handoff` MCP tool (sessions-rethink spec §6.1).
//
// Called by the outgoing agent at the end of `/handoff`. The MCP boundary
// validates the input shape (Zod), resolves the caller's domain server-side,
// and asks the store to persist. The store layer trusts validated input —
// the heading/length contract is enforced here, not there.

import { StoreHandoffInputSchema } from "@librarian/core";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";

const storeHandoff: ToolDefinition = {
  name: "store_handoff",
  description:
    "Persist a handoff document so another agent (or harness) can resume your " +
    "work later. Use it when you're pausing mid-task or ending a session that " +
    "isn't finished. The document must follow the five-section template — Start " +
    "& intent, Journey, Current state, What's left, Open questions — or it is " +
    "rejected.",
  inputSchema: {
    type: "object",
    required: ["title", "document_md"],
    properties: {
      title: { type: "string", minLength: 5, maxLength: 120 },
      document_md: { type: "string", minLength: 100, maxLength: 50000 },
      project_key: { type: ["string", "null"] },
      source_ref: { type: ["string", "null"] },
      cwd: { type: ["string", "null"] },
      harness: { type: ["string", "null"] },
      tags: { type: "array", items: { type: "string" }, maxItems: 10 },
    },
  },
  handler(store, args, context) {
    const parsed = StoreHandoffInputSchema.safeParse(args);
    if (!parsed.success) {
      const reason = parsed.error.issues[0]?.message ?? "invalid handoff input";
      return textResult(`Handoff rejected: ${reason}`);
    }
    const result = store.handoffs.store(parsed.data, {
      created_by_agent_id: context.agentId ?? null,
    });
    return textResult(
      `Handoff stored.\n\nhandoff_id: ${result.handoff_id}\ncreated_at:  ${result.created_at}\n\nPick it up from another agent with /takeover.`,
    );
  },
};

export default storeHandoff;

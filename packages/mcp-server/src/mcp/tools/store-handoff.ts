// `store_handoff` MCP tool (sessions-rethink spec §6.1).
//
// Called by the outgoing agent at the end of `/handoff`. The MCP boundary
// validates the input shape (Zod), resolves the caller's domain server-side,
// and asks the store to persist. The store layer trusts validated input —
// the heading/length contract is enforced here, not there.

import { StoreHandoffInputSchema } from "@librarian/core";
import { resolveCallerDomain } from "../domain-resolution.js";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";

const storeHandoff: ToolDefinition = {
  name: "store_handoff",
  description:
    "Persist a handoff document for cross-agent / cross-harness pickup. The " +
    "document must conform to the five-section template (Start & intent, " +
    "Journey, Current state, What's left, Open questions). Server resolves " +
    "domain from conv_state; caller-supplied domain is ignored.",
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
      conv_id: { type: "string" },
    },
  },
  handler(store, args, context) {
    const parsed = StoreHandoffInputSchema.safeParse(args);
    if (!parsed.success) {
      const reason = parsed.error.issues[0]?.message ?? "invalid handoff input";
      return textResult(`Handoff rejected: ${reason}`);
    }
    const convId = typeof args.conv_id === "string" ? args.conv_id : "";
    const { domain } = resolveCallerDomain(store, convId, context);
    if (domain === null) {
      return textResult(
        "Cannot store handoff: no conv_state for this caller and the install is multi-domain. Run /lib-session-start (or set conv_state) first.",
      );
    }
    const result = store.handoffs.store(parsed.data, {
      domain,
      created_by_agent_id: context.agentId ?? null,
    });
    return textResult(
      `Handoff stored.\n\nhandoff_id: ${result.handoff_id}\ncreated_at:  ${result.created_at}\n\nPick it up from another agent with /takeover.`,
    );
  },
};

export default storeHandoff;

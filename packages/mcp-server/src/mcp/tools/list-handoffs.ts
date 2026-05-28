// `list_handoffs` MCP tool (sessions-rethink spec §6.1).
//
// Called by `/takeover` to populate the picker. Default filter is unclaimed +
// current project_key + current cwd (per §6.1 D9); the agent broadens by
// dropping filters when nothing matches. Domain is server-scoped from the
// caller's conv_state.

import { ListHandoffsInputSchema } from "@librarian/core";
import { resolveCallerDomain } from "../domain-resolution.js";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";

const listHandoffs: ToolDefinition = {
  name: "list_handoffs",
  description:
    "List unclaimed handoffs visible to the calling agent. Default scope is the " +
    "caller's current project_key + cwd when both are supplied; drop either to " +
    "broaden. Server-scoped by domain.",
  inputSchema: {
    type: "object",
    properties: {
      project_key: { type: ["string", "null"] },
      cwd: { type: ["string", "null"] },
      harness: { type: ["string", "null"] },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      conv_id: { type: "string" },
    },
  },
  handler(store, args, context) {
    const parsed = ListHandoffsInputSchema.safeParse(args);
    if (!parsed.success) {
      return textResult(
        `list_handoffs rejected: ${parsed.error.issues[0]?.message ?? "invalid input"}`,
      );
    }
    const convId = typeof args.conv_id === "string" ? args.conv_id : "";
    const { domain } = resolveCallerDomain(store, convId, context);
    if (domain === null && context.role !== "admin") {
      return textResult(
        JSON.stringify({ handoffs: [] }) +
          "\n\n(No conv_state resolved; broaden domain by attaching a session first.)",
      );
    }
    const rows = store.handoffs.list(parsed.data, {
      // Admin sees only "general" by default — handoffs are scoped by domain
      // even for admins; broader admin views are a dashboard concern.
      domain: domain ?? "general",
    });
    return textResult(JSON.stringify({ handoffs: rows }, null, 2));
  },
};

export default listHandoffs;

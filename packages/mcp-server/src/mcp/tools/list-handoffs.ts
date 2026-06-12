// `list_handoffs` MCP tool (sessions-rethink spec §6.1).
//
// Called by `/takeover` to populate the picker. Default filter is unclaimed +
// current project_key + current cwd (per §6.1 D9); the agent broadens by
// dropping filters when nothing matches.

import { ListHandoffsInputSchema } from "@librarian/core";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";

const listHandoffs: ToolDefinition = {
  name: "list_handoffs",
  description:
    "List unclaimed handoffs you could pick up — call this before resuming work " +
    "to see what's waiting. Default scope is the caller's current project_key + " +
    "cwd when both are supplied; drop either to broaden when nothing matches. " +
    "Then `claim_handoff` the one you want.",
  inputSchema: {
    type: "object",
    properties: {
      project_key: { type: ["string", "null"] },
      cwd: { type: ["string", "null"] },
      harness: { type: ["string", "null"] },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
  },
  handler(store, args) {
    const parsed = ListHandoffsInputSchema.safeParse(args);
    if (!parsed.success) {
      return textResult(
        `list_handoffs rejected: ${parsed.error.issues[0]?.message ?? "invalid input"}`,
      );
    }
    const rows = store.handoffs.list(parsed.data, {});
    return textResult(JSON.stringify({ handoffs: rows }, null, 2));
  },
};

export default listHandoffs;

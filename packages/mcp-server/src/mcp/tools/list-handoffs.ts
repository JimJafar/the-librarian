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
    "Take over work, step 1: list the unclaimed handoffs waiting to be picked " +
    "up, then `claim_handoff` the one you want. Default scope is the caller's " +
    "current project_key + cwd when both are supplied; drop either filter to " +
    "broaden when nothing matches.",
  inputSchema: {
    type: "object",
    properties: {
      project_key: {
        type: ["string", "null"],
        description:
          "Restrict to handoffs for this project. The default scope is the caller's current " +
          "project; drop this filter to broaden when nothing matches.",
      },
      cwd: {
        type: ["string", "null"],
        description:
          "Restrict to handoffs created in this working directory; drop it to broaden the search.",
      },
      harness: {
        type: ["string", "null"],
        description:
          "Restrict to handoffs created in this harness; drop it to broaden across harnesses.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        description: "Maximum number of handoffs to return.",
      },
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

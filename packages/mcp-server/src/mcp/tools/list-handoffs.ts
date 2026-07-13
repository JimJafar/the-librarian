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
  handler(store, args, context) {
    const parsed = ListHandoffsInputSchema.safeParse(args);
    if (!parsed.success) {
      return textResult(
        `list_handoffs rejected: ${parsed.error.issues[0]?.message ?? "invalid input"}`,
      );
    }
    // Route across the principal's RECALL shelves (spec 062 review F): under a rootless Teams tree a
    // member's handoffs live under their own shelf (`members/x/handoffs/`), NOT the vault root, so a
    // root-only list would never surface a handoff the member just stored. Merge each recall shelf's
    // list, then re-sort newest-first and re-slice to the same limit — preserving today's single-shelf
    // sort semantics across the merged set. Default router → one shelf (the vault root) → byte-identical.
    const shelves = store.vaultRouter.shelves(context.principal, "recall");
    const merged = shelves.flatMap((shelf) => store.forShelf(shelf).handoffs.list(parsed.data, {}));
    merged.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    // Cap the MERGED set at the same effective limit each shelf's `list` applied (its default is 20),
    // so a two-shelf list returns the same count a single-shelf list would — not limit×shelves.
    const rows = merged.slice(0, parsed.data.limit ?? 20);
    return textResult(JSON.stringify({ handoffs: rows }, null, 2));
  },
};

export default listHandoffs;

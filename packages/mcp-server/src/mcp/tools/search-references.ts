// `search_references` MCP tool (plan 036 Phase 3 / spec 035 §F3-F4). Tier-0
// lookup over the vault's references/ — background reference docs that are NOT
// in default recall. Returns each match's pointer (vault-relative path) + the
// query-relevant section, so the agent can pull just the matched section.

import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";

const searchReferences: ToolDefinition = {
  name: "search_references",
  description:
    "Search Tier-0 reference docs (references/) by query. Returns each match's " +
    "path + the relevant section. References are background material — they are " +
    "not in normal recall; use this to look them up on demand.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look up in the references." },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
    required: ["query"],
  },
  async handler(store, args) {
    const query = typeof args.query === "string" ? args.query : "";
    if (!query.trim()) return textResult("search_references rejected: 'query' is required");
    // store.searchReferences clamps the limit (the invariant lives there).
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    const hits = await store.searchReferences(query, limit);
    return textResult(JSON.stringify({ references: hits }, null, 2));
  },
};

export default searchReferences;

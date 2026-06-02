// `find_skills` MCP tool (plan 036 Phase 5 / spec 035 §F7). Ranks the skill
// manifest against a query (keyword + vector hybrid over name + description)
// and returns the matches (slug, name, description, score). Uses the bundled
// hash embedder for now — the real model is a drop-in via the same Embedder
// seam, no change here.

import { createHashEmbedder, findSkills } from "@librarian/core";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";

const findSkillsTool: ToolDefinition = {
  name: "find_skills",
  description:
    "Search the skill manifest by relevance to a query. Returns matching " +
    "skills (slug, name, description, score), best first.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What you're looking for." },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
    required: ["query"],
  },
  async handler(store, args) {
    const query = typeof args.query === "string" ? args.query : "";
    if (!query.trim()) return textResult("find_skills rejected: 'query' is required");
    // clamp the caller-supplied limit; non-positive/absent → the function default
    const limit =
      typeof args.limit === "number" && args.limit > 0
        ? Math.min(Math.floor(args.limit), 100)
        : undefined;
    const hits = await findSkills(store.skills.listSkills(), query, createHashEmbedder(), limit);
    return textResult(JSON.stringify({ skills: hits }, null, 2));
  },
};

export default findSkillsTool;

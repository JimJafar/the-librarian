// `get_skill` MCP tool (plan 036 Phase 5 / spec 035 §F7). Returns a skill's
// full SKILL.md (frontmatter + body) plus its resource file list, by slug.
// Fail-soft: an unknown/invalid/malformed slug returns `{ skill: null }` (the
// store never throws on caller input).

import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";

const getSkill: ToolDefinition = {
  name: "get_skill",
  description:
    "Fetch a skill's full document (name, description, body) and its resource " +
    "file list, by slug. Returns { skill: null } when the slug is unknown.",
  inputSchema: {
    type: "object",
    properties: {
      slug: { type: "string", description: "The skill slug (its directory name under skills/)." },
    },
    required: ["slug"],
  },
  handler(store, args) {
    const slug = typeof args.slug === "string" ? args.slug : "";
    if (!slug) return textResult("get_skill rejected: 'slug' is required");
    return textResult(JSON.stringify({ skill: store.skills.getSkill(slug) }, null, 2));
  },
};

export default getSkill;

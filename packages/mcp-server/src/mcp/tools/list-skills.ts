// `list_skills` MCP tool (ADR 0006). Returns the bounded skills manifest —
// `{ slug, name, description }` per entry — from the server-hosted catalog
// (`store.skills.listSkills()`). `get_skill(slug)` fetches one skill's full
// document on demand. Replaces the retired `session_manifest` (working-style
// moved into the injected primer) and `find_skills` (ranked search is overkill
// for a small catalog; the model picks from this list).

import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";

const listSkills: ToolDefinition = {
  name: "list_skills",
  description:
    "List the server-hosted skills (slug, name, description) available to load. " +
    "Use `get_skill` to fetch one skill's full document by slug.",
  inputSchema: { type: "object", properties: {} },
  handler(store) {
    return textResult(JSON.stringify({ skills: store.skills.listSkills() }, null, 2));
  },
};

export default listSkills;

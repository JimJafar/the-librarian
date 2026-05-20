import { formatSessionSearch } from "../formatters.js";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { scopeAgentArgs } from "../visibility.js";

const searchSessions: ToolDefinition = {
  name: "search_sessions",
  description: "Search session summaries and events. Archived/deleted excluded by default.",
  inputSchema: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string" },
      project_key: { type: "string" },
      include_archived: { type: "boolean" },
      include_deleted: { type: "boolean" },
      limit: { type: "number" },
    },
  },
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    const result = store.searchSessions(scoped);
    return textResult(formatSessionSearch(result));
  },
};

export default searchSessions;

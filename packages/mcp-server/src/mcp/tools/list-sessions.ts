import { formatSessionList } from "../formatters.js";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { scopeAgentArgs } from "../visibility.js";

const listSessions: ToolDefinition = {
  name: "list_sessions",
  description:
    "Return selectable sessions ranked for resume. Never auto-selects. " +
    "Defaults to active + paused; pass `include_ended: true` to see ended sessions too.",
  inputSchema: {
    type: "object",
    properties: {
      project_key: { type: "string" },
      source_ref: { type: "string" },
      cwd: { type: "string" },
      harness: { type: "string" },
      status: { type: "array", items: { type: "string" } },
      include_ended: { type: "boolean" },
      limit: { type: "number" },
    },
  },
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    const result = store.listSessions(scoped);
    return textResult(formatSessionList(result));
  },
};

export default listSessions;

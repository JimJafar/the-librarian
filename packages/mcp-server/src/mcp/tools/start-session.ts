import { formatSessionStart } from "../formatters.js";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { scopeAgentArgs } from "../visibility.js";

const startSession: ToolDefinition = {
  name: "start_session",
  description: "Start a new Librarian session, attributed to the calling agent.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      project_key: { type: "string" },
      visibility: { type: "string", enum: ["common", "agent_private"] },
      harness: { type: "string" },
      source_ref: { type: "string" },
      cwd: { type: "string" },
      capture_mode: { type: "string", enum: ["off", "summary", "log"] },
      start_summary: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      next_steps: { type: "array", items: { type: "string" } },
    },
  },
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    const result = store.startSession(scoped);
    return textResult(formatSessionStart(result.session!));
  },
};

export default startSession;

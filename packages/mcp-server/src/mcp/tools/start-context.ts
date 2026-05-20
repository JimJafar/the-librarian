import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { scopeAgentArgs } from "../visibility.js";

const startContext: ToolDefinition = {
  name: "start_context",
  description: "Return required clean prose context for an agent at task start.",
  inputSchema: {
    type: "object",
    properties: {
      agent_id: { type: "string" },
      project_key: { type: "string" },
      task_summary: { type: "string" },
    },
  },
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    const result = store.startContext(scoped);
    return textResult(result.text);
  },
};

export default startContext;

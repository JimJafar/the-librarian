import { formatSessionLifecycle } from "../formatters.js";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { isSessionVisible, scopeAgentArgs } from "../visibility.js";
import { sessionLifecycleSchema } from "./schemas.js";

function endSessionSchema(): Record<string, unknown> {
  const base = sessionLifecycleSchema();
  return {
    ...base,
    properties: {
      ...base.properties,
      candidate_memories: { type: "array", items: { type: "object" } },
    },
  };
}

const endSession: ToolDefinition = {
  name: "end_session",
  description:
    "Mark the session ended. Writes end_summary; rolling_summary is frozen at the last checkpoint.",
  inputSchema: endSessionSchema(),
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    const session = store.getSession(scoped.session_id as string);
    if (!isSessionVisible(session, context)) {
      return textResult(`No session found for id ${scoped.session_id as string}.`);
    }
    const result = store.endSession(scoped);
    return textResult(formatSessionLifecycle(result.session!, "Session ended."));
  },
};

export default endSession;

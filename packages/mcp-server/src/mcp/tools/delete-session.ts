import { formatSessionLifecycle } from "../formatters.js";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { isSessionVisible, scopeAgentArgs } from "../visibility.js";

const deleteSession: ToolDefinition = {
  name: "delete_session",
  description: "Soft-delete a session. Owner may delete their own sessions; admin may delete any.",
  inputSchema: {
    type: "object",
    required: ["session_id"],
    properties: {
      session_id: { type: "string" },
      reason: { type: "string" },
    },
  },
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    const session = store.getSession(scoped.session_id as string);
    if (!isSessionVisible(session, context)) {
      return textResult(`No session found for id ${scoped.session_id as string}.`);
    }
    const result = store.deleteSession(scoped);
    return textResult(formatSessionLifecycle(result.session!, "Session deleted."));
  },
};

export default deleteSession;

import { formatSessionEvents } from "../formatters.js";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { isSessionVisible, scopeAgentArgs } from "../visibility.js";
import { SESSION_PAYLOAD_TYPE_VALUES } from "./schemas.js";

const listSessionEvents: ToolDefinition = {
  name: "list_session_events",
  description: "Return the event stream for a session, paginated and optionally type-filtered.",
  inputSchema: {
    type: "object",
    required: ["session_id"],
    properties: {
      session_id: { type: "string" },
      type: { type: "string", enum: SESSION_PAYLOAD_TYPE_VALUES },
      limit: { type: "number" },
      offset: { type: "number" },
    },
  },
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    const session = store.getSession(scoped.session_id as string);
    if (!isSessionVisible(session, context)) {
      return textResult(`No session found for id ${scoped.session_id as string}.`);
    }
    const result = store.listSessionEvents(scoped);
    return textResult(formatSessionEvents(result, session));
  },
};

export default listSessionEvents;

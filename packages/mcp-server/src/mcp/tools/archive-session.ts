import { formatSessionLifecycle } from "../formatters.js";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { isSessionVisible, scopeAgentArgs } from "../visibility.js";

const archiveSession: ToolDefinition = {
  name: "archive_session",
  description:
    "Hide a session from default lists while keeping it searchable via include_archived.",
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
    const result = store.archiveSession(scoped);
    return textResult(formatSessionLifecycle(result.session!, "Session archived."));
  },
};

export default archiveSession;

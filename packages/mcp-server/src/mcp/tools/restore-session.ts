import { formatSessionLifecycle } from "../formatters.js";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { isSessionVisible, scopeAgentArgs } from "../visibility.js";

const restoreSession: ToolDefinition = {
  name: "restore_session",
  description:
    "Restore an archived or soft-deleted session to its prior status. Owner-or-admin only.",
  inputSchema: {
    type: "object",
    required: ["session_id"],
    properties: {
      session_id: { type: "string" },
    },
  },
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    const session = store.getSession(scoped.session_id as string);
    if (!isSessionVisible(session, context)) {
      return textResult(`No session found for id ${scoped.session_id as string}.`);
    }
    const result = store.restoreSession(scoped);
    const restored = result.session!;
    return textResult(formatSessionLifecycle(restored, `Session restored to ${restored.status}.`));
  },
};

export default restoreSession;

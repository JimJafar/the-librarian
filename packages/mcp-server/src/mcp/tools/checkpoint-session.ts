import { formatSessionLifecycle } from "../formatters.js";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { isSessionVisible, scopeAgentArgs } from "../visibility.js";
import { sessionLifecycleSchema } from "./schemas.js";

const checkpointSession: ToolDefinition = {
  name: "checkpoint_session",
  description: "Update the rolling summary, decisions, and next steps. Keeps the session active.",
  inputSchema: sessionLifecycleSchema(),
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    const session = store.getSession(scoped.session_id as string);
    if (!isSessionVisible(session, context)) {
      return textResult(`No session found for id ${scoped.session_id as string}.`);
    }
    const result = store.checkpointSession(scoped);
    return textResult(formatSessionLifecycle(result.session!, "Checkpoint recorded."));
  },
};

export default checkpointSession;

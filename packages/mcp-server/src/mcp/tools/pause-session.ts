import { formatSessionLifecycle } from "../formatters.js";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { isSessionVisible, scopeAgentArgs } from "../visibility.js";
import { sessionLifecycleSchema } from "./schemas.js";

const pauseSession: ToolDefinition = {
  name: "pause_session",
  description: "Mark the session paused and store a pause summary. Activity resumes it implicitly.",
  inputSchema: sessionLifecycleSchema(),
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    const session = store.getSession(scoped.session_id as string);
    if (!isSessionVisible(session, context)) {
      return textResult(`No session found for id ${scoped.session_id as string}.`);
    }
    const result = store.pauseSession(scoped);
    return textResult(formatSessionLifecycle(result.session!, "Session paused."));
  },
};

export default pauseSession;

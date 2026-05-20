import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { isSessionVisible, scopeAgentArgs } from "../visibility.js";
import { SESSION_PAYLOAD_TYPE_VALUES } from "./schemas.js";

const recordSessionEvent: ToolDefinition = {
  name: "record_session_event",
  description:
    "Record a typed evidence event on a visible session. Implicitly resumes a paused session.",
  inputSchema: {
    type: "object",
    required: ["session_id", "type", "summary"],
    properties: {
      session_id: { type: "string" },
      type: { type: "string", enum: SESSION_PAYLOAD_TYPE_VALUES },
      summary: { type: "string" },
      payload: { type: "object" },
      harness: { type: "string" },
      source_ref: { type: "string" },
    },
  },
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    const session = store.getSession(scoped.session_id as string);
    if (!isSessionVisible(session, context)) {
      return textResult(`No session found for id ${scoped.session_id as string}.`);
    }
    store.recordSessionEvent(scoped);
    return textResult(
      `Recorded ${scoped.type as string} on session ${scoped.session_id as string}.`,
    );
  },
};

export default recordSessionEvent;

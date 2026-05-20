import { formatSessionLifecycle } from "../formatters.js";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { isSessionVisible, scopeAgentArgs } from "../visibility.js";

const attachSession: ToolDefinition = {
  name: "attach_session",
  description:
    "Record attachment of a session to the calling harness/source without generating a handover.",
  inputSchema: {
    type: "object",
    required: ["session_id"],
    properties: {
      session_id: { type: "string" },
      harness: { type: "string" },
      source_ref: { type: "string" },
      cwd: { type: "string" },
    },
  },
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    const session = store.getSession(scoped.session_id as string);
    if (!isSessionVisible(session, context)) {
      return textResult(`No session found for id ${scoped.session_id as string}.`);
    }
    const result = store.attachSession(scoped);
    const updated = result.session!;
    return textResult(
      formatSessionLifecycle(
        updated,
        `Attached to ${updated.current_harness || "(unspecified harness)"}.`,
      ),
    );
  },
};

export default attachSession;

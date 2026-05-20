import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { isSessionVisible, scopeAgentArgs } from "../visibility.js";

const continueSession: ToolDefinition = {
  name: "continue_session",
  description:
    "Generate a handover package for the session and (by default) attach to the target harness.",
  inputSchema: {
    type: "object",
    required: ["session_id"],
    properties: {
      session_id: { type: "string" },
      target_harness: { type: "string" },
      target_source_ref: { type: "string" },
      target_cwd: { type: "string" },
      attach: { type: "boolean" },
      format: {
        type: "string",
        enum: ["prose", "markdown", "claude", "codex", "opencode", "hermes", "pi"],
      },
    },
  },
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    const session = store.getSession(scoped.session_id as string);
    if (!isSessionVisible(session, context)) {
      return textResult(`No session found for id ${scoped.session_id as string}.`);
    }
    const result = store.continueSession(scoped);
    return textResult(result.text);
  },
};

export default continueSession;

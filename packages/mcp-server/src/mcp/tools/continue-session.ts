import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { isSessionVisible, scopeAgentArgs } from "../visibility.js";

const continueSession: ToolDefinition = {
  name: "continue_session",
  description:
    "Generate a handover package for the session and (by default) attach to the target harness. " +
    "When `conv_id` is supplied, the resuming conv_state is seeded (or overwritten) with the " +
    "session's `domain` per spec §4.12 — the signal-precedence chain is intentionally bypassed " +
    "on resume since the operator's resume action is itself the domain signal.",
  inputSchema: {
    type: "object",
    required: ["session_id"],
    properties: {
      session_id: { type: "string" },
      target_harness: { type: "string" },
      target_source_ref: { type: "string" },
      target_cwd: { type: "string" },
      attach: { type: "boolean" },
      conv_id: { type: "string" },
      format: {
        type: "string",
        enum: ["prose", "markdown", "claude", "codex", "opencode", "hermes", "pi"],
      },
    },
  },
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    const convId = typeof scoped.conv_id === "string" ? scoped.conv_id : "";
    delete scoped.conv_id;
    const session = store.getSession(scoped.session_id as string);
    if (!isSessionVisible(session, context)) {
      return textResult(`No session found for id ${scoped.session_id as string}.`);
    }
    const result = store.continueSession(scoped);
    if (convId && session) {
      // §4.12 — seed the resuming conv_state's domain from the session.
      // Uses `upsert` rather than a direct INSERT so existing rows are
      // overwritten (the operator's resume action is the canonical
      // signal of intent, overriding whatever the conv had before).
      store.convState.upsert(convId, {
        harness:
          typeof scoped.target_harness === "string"
            ? scoped.target_harness
            : (session.current_harness ?? "unknown"),
        domain: session.domain,
        session_id: session.id,
      });
    }
    return textResult(result.text);
  },
};

export default continueSession;

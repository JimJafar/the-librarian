import { formatSessionStart } from "../formatters.js";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { scopeAgentArgs } from "../visibility.js";

const startSession: ToolDefinition = {
  name: "start_session",
  description:
    "Start a new Librarian session, attributed to the calling agent. The " +
    "session inherits its `domain` from the calling conv_state (when `conv_id` " +
    "is supplied and a row exists); otherwise the §4.10 single-domain fast " +
    "path applies; otherwise the session defaults to `general`.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      project_key: { type: "string" },
      visibility: { type: "string", enum: ["common", "agent_private"] },
      harness: { type: "string" },
      source_ref: { type: "string" },
      cwd: { type: "string" },
      capture_mode: { type: "string", enum: ["off", "summary", "log"] },
      start_summary: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      next_steps: { type: "array", items: { type: "string" } },
      conv_id: { type: "string", description: "Conversation identifier from the harness hook." },
    },
  },
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    const convId = typeof scoped.conv_id === "string" ? scoped.conv_id : "";
    delete scoped.conv_id;
    const state = convId ? store.convState.get(convId) : null;
    if (state) {
      scoped.domain = state.domain;
    } else if (!scoped.domain) {
      const rows = store.db.prepare("SELECT name FROM domains LIMIT 2").all() as Array<{
        name: string;
      }>;
      scoped.domain = rows.length === 1 ? (rows[0]?.name ?? "general") : "general";
    }
    const result = store.startSession(scoped);
    return textResult(formatSessionStart(result.session!));
  },
};

export default startSession;

// R3 — admin-only hard purge for an ended session. Deletes the SQLite
// row + session_state_changes audit + rewrites session_events.jsonl to
// remove the purged session's events. Refuses to purge active / paused
// sessions; ending must come first. There is no soft-delete equivalent
// in the three-state model (`ended` already covers the hide-from-view
// case), so this is the only path that ever removes a session
// permanently.

import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";

const purgeSession: ToolDefinition = {
  name: "purge_session",
  description:
    "Permanently delete an ended session: SQLite row + state-change audit + timeline events on disk. " +
    "Refuses to purge active / paused sessions. Admin-only.",
  inputSchema: {
    type: "object",
    required: ["session_id", "confirm"],
    properties: {
      session_id: { type: "string" },
      confirm: { type: "boolean", const: true },
    },
  },
  adminOnly: true,
  handler(store, args) {
    const sessionId = (args as Record<string, unknown>).session_id as string;
    const confirm = (args as Record<string, unknown>).confirm === true;
    if (!confirm) {
      throw new Error("purge_session requires `confirm: true` to proceed.");
    }
    const result = store.purgeSession({ session_id: sessionId });
    return textResult(
      `Purged session ${result.session_id}: ${result.events_removed} timeline events, ${result.state_changes_removed} state changes removed.`,
    );
  },
};

export default purgeSession;

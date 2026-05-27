import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { requireString } from "./conv-state-shared.js";

const convStateUpsert: ToolDefinition = {
  name: "conv_state_upsert",
  description:
    "Create or update the conversation-state row for the supplied conv_id. " +
    "First-create requires both `harness` and `domain`; subsequent updates accept any subset of " +
    "the four mutable fields. Setting `session_id: null` explicitly clears the attached session. " +
    "TODO(PR 3): cross-check `domain` against the `domains` table — agents currently can write " +
    "rows pointing at a non-existent domain; `start_session` will gate this once PR 3 lands.",
  inputSchema: {
    type: "object",
    required: ["conv_id"],
    additionalProperties: false,
    properties: {
      conv_id: { type: "string", minLength: 1, description: "Harness-supplied conv identifier." },
      harness: {
        type: "string",
        minLength: 1,
        description: "Harness name (e.g. 'claude-code', 'hermes'). Required on first create.",
      },
      domain: {
        type: "string",
        minLength: 1,
        description:
          "Owner-defined domain (e.g. 'coding', 'family-admin'). Required on first create.",
      },
      session_id: {
        type: ["string", "null"],
        description: "Attached Librarian session id, or explicit null to clear.",
      },
      off_record: {
        type: "boolean",
        description: "When true, automatic capture into the session ledger pauses.",
      },
    },
  },
  handler(store, args) {
    const convId = requireString(args.conv_id, "conv_state.upsert: conv_id is required.");
    const patch: Record<string, unknown> = {};
    if (typeof args.harness === "string") patch.harness = args.harness;
    if (typeof args.domain === "string") patch.domain = args.domain;
    if (args.session_id === null || typeof args.session_id === "string") {
      patch.session_id = args.session_id;
    }
    if (typeof args.off_record === "boolean") patch.off_record = args.off_record;
    const next = store.convState.upsert(convId, patch);
    return textResult(JSON.stringify(next, null, 2));
  },
};

export default convStateUpsert;

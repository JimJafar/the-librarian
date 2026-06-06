import { readAwarenessPrimer } from "@librarian/core";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { requireString } from "./conv-state-shared.js";

const convStateGet: ToolDefinition = {
  name: "conv_state_get",
  description:
    "Return the conversation-state row for the supplied conv_id (or just the awareness " +
    "primer when no row exists), always with an additive top-level `primer` field. " +
    "Hook code calls this on every turn to re-inject the canonical block from spec §4.9 " +
    "plus the server-sourced awareness primer (spec 041).",
  inputSchema: {
    type: "object",
    required: ["conv_id"],
    additionalProperties: false,
    properties: {
      conv_id: {
        type: "string",
        minLength: 1,
        description: "Harness-supplied conversation identifier.",
      },
    },
  },
  handler(store, args) {
    const convId = requireString(args.conv_id, "conv_state.get: conv_id is required.");
    const state = store.convState.get(convId);
    // Spec 041 Decision 1 — the awareness primer is an ADDITIVE top-level field
    // returned on EVERY call, whether or not a row exists. It is global (not
    // conv_id-keyed), so it works on the first turn / on Codex (no stable id).
    // `readAwarenessPrimer` is fail-soft (→ "" on an unreadable store), so this
    // read never throws and never blocks the turn.
    const primer = readAwarenessPrimer(store);
    // With a row: row fields stay TOP-LEVEL (back-compat — un-updated plugins'
    // conv_id-based parsing is untouched) plus the additive `primer`.
    // With no row: just `{ primer }` (replacing the old "No conversation state…"
    // text); old plugins find no `conv_id` → no block, exactly as before.
    const response = state ? { ...state, primer } : { primer };
    return textResult(JSON.stringify(response, null, 2));
  },
};

export default convStateGet;

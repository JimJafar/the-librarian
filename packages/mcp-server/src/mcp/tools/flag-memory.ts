import { DEFAULT_AGENT_ID } from "@librarian/core";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { scopeAgentArgs } from "../visibility.js";

// A flag's free-text reason is untrusted agent input; cap it so a runaway value
// can't bloat the memory doc, and reject an empty one (a flag needs a why).
const MAX_REASON_LEN = 2000;

const flagMemory: ToolDefinition = {
  name: "flag_memory",
  description:
    "A recalled memory is wrong, misleading, or outdated — flag it with a short " +
    "free-text `reason` (required: say why). The flag routes the memory to human " +
    "review and demotes it below unflagged matches in recall; it never edits, " +
    "archives, or deletes, and there is no 'this was useful' counterpart. Use it " +
    "sparingly, only when a memory actively led you astray.",
  inputSchema: {
    type: "object",
    required: ["memory_id", "reason"],
    properties: {
      agent_id: { type: "string" },
      memory_id: { type: "string" },
      reason: { type: "string", minLength: 1, maxLength: MAX_REASON_LEN },
    },
  },
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    const reason = (typeof scoped.reason === "string" ? scoped.reason : "").trim();
    if (!reason) {
      return textResult(
        "flag_memory rejected: 'reason' is required — say why the memory is wrong (incorrect, misleading, outdated…).",
      );
    }
    if (reason.length > MAX_REASON_LEN) {
      return textResult(
        `flag_memory rejected: 'reason' is too long (${reason.length} chars; max ${MAX_REASON_LEN}).`,
      );
    }
    // The flagger is always the calling agent, resolved server-side by
    // scopeAgentArgs — never a client-supplied agent_id.
    const flagged = store.flagMemory(
      scoped.memory_id as string,
      reason,
      (scoped.agent_id as string) || DEFAULT_AGENT_ID,
    );
    if (!flagged) {
      return textResult(
        `No memory found for id ${String(scoped.memory_id)} — nothing was flagged. ` +
          "Double-check the id from your recall results.",
      );
    }
    return textResult(`Flag recorded for review.\n\n${flagged.title}`);
  },
};

export default flagMemory;

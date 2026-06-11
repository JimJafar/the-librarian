import { DEFAULT_AGENT_ID } from "@librarian/core";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { scopeAgentArgs } from "../visibility.js";

const flagMemory: ToolDefinition = {
  name: "flag_memory",
  description:
    "Flag a recalled memory you believe is incorrect, misleading, or outdated, " +
    "with a short free-text `reason`. The flag routes the memory to human review " +
    "and ranks it below unflagged matches in recall — it never edits, archives, or " +
    "deletes the memory, and there is no 'this was useful' counterpart. Use it " +
    "sparingly, only when a memory actively led you astray.",
  inputSchema: {
    type: "object",
    required: ["memory_id", "reason"],
    properties: {
      agent_id: { type: "string" },
      memory_id: { type: "string" },
      reason: { type: "string" },
    },
  },
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    // The flagger is always the calling agent, resolved server-side by
    // scopeAgentArgs — never a client-supplied agent_id.
    const flagged = store.flagMemory(
      scoped.memory_id as string,
      (scoped.reason as string) || "",
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

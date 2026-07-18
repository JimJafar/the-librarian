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
      agent_id: {
        type: "string",
        description:
          "Server-populated from your authenticated token, not supplied by you — it records " +
          "which agent raised the flag.",
      },
      memory_id: {
        type: "string",
        description:
          "The id of the memory to flag — take it from a recall result fetched with include_ids: true.",
      },
      reason: {
        type: "string",
        minLength: 1,
        maxLength: MAX_REASON_LEN,
        description:
          "Why the memory is wrong, misleading, or outdated (required). Free text, recorded for the human reviewer.",
      },
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
    // Route across the principal's RECALL shelves (spec 062 review F): a recalled memory can live on
    // any of the principal's shelves (a member recalls team memories the recall tool's own description
    // advertises flagging), NOT just the vault root — a root-only flag would silently find nothing.
    // Locate the memory by id (an un-gated read) on each recall shelf in router order, then flag through
    // THAT shelf's per-call gated view. A flag is a principal-attributed MUTATION, so it respects the
    // shelf's `writable`: flagging a recalled READ-ONLY team memory raises the typed
    // ShelfNotWritableError (surfaced cleanly by the dispatch) — the honest Teams answer. Default router
    // → one shelf (the vault root) → byte-identical.
    const memoryId = scoped.memory_id as string;
    // The flagger is always the calling agent, resolved server-side by scopeAgentArgs.
    const agentId = (scoped.agent_id as string) || DEFAULT_AGENT_ID;
    const shelves = store.vaultRouter.shelves(context.principal, "recall");
    const target = shelves.find((shelf) => store.forShelf(shelf).getMemory(memoryId) != null);
    const flagged = target
      ? store.forShelf(target, context.principal).flagMemory(memoryId, reason, agentId)
      : null;
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

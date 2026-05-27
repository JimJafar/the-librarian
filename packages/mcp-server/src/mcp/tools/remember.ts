import type { LibrarianStore } from "@librarian/core";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { scopeAgentArgs } from "../visibility.js";
import { memoryInputSchema } from "./schemas.js";

// Returns the sole domain name when the install has exactly one row in
// the `domains` table; otherwise null. Used by `remember` to honour the
// §4.10 single-domain fast path that keeps zero-config installs from
// having to set up conv_state.
function readSingleDomain(store: LibrarianStore): string | null {
  const rows = store.db.prepare("SELECT name FROM domains LIMIT 2").all() as Array<{
    name: string;
  }>;
  return rows.length === 1 ? (rows[0]?.name ?? null) : null;
}

const remember: ToolDefinition = {
  name: "remember",
  description:
    "Save a durable memory. The server sets `domain` from the calling " +
    "conversation's conv_state (if `conv_id` is supplied and a row exists); " +
    "otherwise the memory routes to the proposal queue with `domain=NULL` " +
    "and `requires_approval=true` so the owner can pick a domain at approval " +
    "time. Caller-supplied `domain`, `is_global`, and `requires_approval` " +
    "are ignored (spec §4.1–§4.4).",
  inputSchema: memoryInputSchema(),
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    const convId = typeof scoped.conv_id === "string" ? scoped.conv_id : "";
    // Strip the conv_id wrapper before it reaches createMemory — it's a
    // routing signal for the handler, not a memory field.
    delete scoped.conv_id;
    const state = convId ? store.convState.get(convId) : null;
    // Spec §4.10 special case — when the operator has not added a
    // second domain, the entire signal-precedence chain (and the
    // outside-session proposal route) collapses to "use the single
    // domain." This keeps zero-config installs zero-friction and
    // preserves PR 1's behaviour for callers that don't yet supply a
    // conv_id.
    const singleDomain = !state ? readSingleDomain(store) : null;
    const result = state
      ? store.createMemory(scoped, { domain: state.domain })
      : singleDomain
        ? store.createMemory(scoped, { domain: singleDomain })
        : store.createMemory(scoped, { outsideSession: true });
    const suffix =
      result.status === "proposed"
        ? state || singleDomain
          ? "This memory is protected and has been saved as a proposal for review."
          : "No conversation state for this caller; memory saved as a proposal awaiting an owner-assigned domain."
        : "Memory saved.";
    const duplicateText = result.duplicates?.length
      ? `\n\nPossible duplicates:\n${result.duplicates
          .map((memory) => `- ${memory.title}: ${memory.body}`)
          .join("\n")}`
      : "";
    return textResult(`${suffix}\n\n${result.memory.title}: ${result.memory.body}${duplicateText}`);
  },
};

export default remember;

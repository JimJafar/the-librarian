import { isClassifierRuntimeActive } from "../../classifier-startup.js";
import { resolveCallerDomain } from "../domain-resolution.js";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { scopeAgentArgs } from "../visibility.js";
import { memoryInputSchema } from "./schemas.js";

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
    const { domain, source } = resolveCallerDomain(store, convId, context);
    // §4.14: an unresolvable domain on a multi-domain install routes
    // the write to the proposal queue with domain=NULL. The §4.10 fast
    // path and the conv_state hit both produce a concrete domain.
    //
    // Section 4d cutover — when the classifier worker is active
    // (mcp-server's boot called `bootClassifierWorker` successfully),
    // every write lands at conservative defaults so the worker is the
    // source of truth for is_global + requires_approval. Otherwise the
    // legacy bridge in `normalizeMemoryInput` decides; 4d.2 collapses
    // the legacy path.
    const baseOpts: Record<string, unknown> = isClassifierRuntimeActive()
      ? { pendingClassification: true }
      : {};
    const result =
      source === "none"
        ? store.createMemory(scoped, { ...baseOpts, outsideSession: true })
        : store.createMemory(scoped, { ...baseOpts, domain });
    const suffix =
      result.status === "proposed"
        ? source === "none"
          ? "No conversation state for this caller; memory saved as a proposal awaiting an owner-assigned domain."
          : "This memory is protected and has been saved as a proposal for review."
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

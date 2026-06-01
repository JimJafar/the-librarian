import { isClassifierRuntimeActive } from "../../classifier-startup.js";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { scopeAgentArgs } from "../visibility.js";
import { memoryInputSchema } from "./schemas.js";

const remember: ToolDefinition = {
  name: "remember",
  description:
    "Save a durable memory. When the classifier worker is active, the write " +
    "lands at conservative defaults and the worker decides `is_global` + " +
    "`requires_approval`, routing protected memories to the proposal queue. " +
    "Caller-supplied `is_global` / `requires_approval` are ignored (spec §4.1–§4.4).",
  inputSchema: memoryInputSchema(),
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    // conv_id was a domain-routing signal, not a memory field.
    delete scoped.conv_id;
    // Section 4d cutover — when the classifier worker is active, every write
    // lands at conservative defaults so the worker is the source of truth for
    // is_global + requires_approval (and routes protected writes to proposals).
    const baseOpts: Record<string, unknown> = isClassifierRuntimeActive()
      ? { pendingClassification: true }
      : {};
    const result = store.createMemory(scoped, baseOpts);
    const suffix =
      result.status === "proposed"
        ? "This memory is protected and has been saved as a proposal for review."
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

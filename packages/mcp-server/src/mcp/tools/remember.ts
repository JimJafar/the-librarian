import { formatConflict, textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { scopeAgentArgs } from "../visibility.js";
import { memoryInputSchema } from "./schemas.js";

const remember: ToolDefinition = {
  name: "remember",
  description: "Save a durable memory. Protected categories become proposals.",
  inputSchema: memoryInputSchema(),
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    const result = store.createMemory(scoped);
    if (result.status === "conflict") {
      return textResult(formatConflict(result));
    }
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

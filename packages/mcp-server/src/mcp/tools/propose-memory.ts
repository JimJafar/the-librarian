import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { scopeAgentArgs } from "../visibility.js";
import { memoryInputSchema } from "./schemas.js";

const proposeMemory: ToolDefinition = {
  name: "propose_memory",
  description: "Create a proposed memory for review.",
  inputSchema: memoryInputSchema(),
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    const result = store.createMemory({ ...scoped, status: "proposed" }, { status: "proposed" });
    return textResult(`Memory proposal saved.\n\n${result.memory.title}: ${result.memory.body}`);
  },
};

export default proposeMemory;

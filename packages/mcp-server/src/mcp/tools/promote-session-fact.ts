import { formatPromotionConflict, textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { isSessionVisible, scopeAgentArgs } from "../visibility.js";

const promoteSessionFact: ToolDefinition = {
  name: "promote_session_fact",
  description:
    "Promote a fact from a visible session into a durable memory (or proposal for protected categories).",
  inputSchema: {
    type: "object",
    required: ["session_id", "memory"],
    properties: {
      session_id: { type: "string" },
      session_event_id: { type: "string" },
      memory: { type: "object" },
    },
  },
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    const session = store.getSession(scoped.session_id as string);
    if (!isSessionVisible(session, context)) {
      return textResult(`No session found for id ${scoped.session_id as string}.`);
    }
    const result = store.promoteSessionFact(scoped);
    if (result.status === "conflict") {
      return textResult(formatPromotionConflict(result));
    }
    const headline =
      result.status === "proposed"
        ? "Promoted to memory proposal (awaiting review)."
        : "Promoted to active memory.";
    const memory = result.memory as unknown as { title: string; body: string };
    return textResult(`${headline}\n\n${memory.title}: ${memory.body}`);
  },
};

export default promoteSessionFact;

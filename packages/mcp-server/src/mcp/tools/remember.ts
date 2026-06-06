import type { InboxSubmissionHints } from "@librarian/core";
import { isConsolidatorEnabled } from "../../consolidator-config.js";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { scopeAgentArgs } from "../visibility.js";
import { memoryInputSchema } from "./schemas.js";

/** The submitter's filing/ownership hints, carried onto the consolidated memory. */
function submissionHints(scoped: Record<string, unknown>): InboxSubmissionHints {
  const hints: InboxSubmissionHints = {};
  if (typeof scoped.agent_id === "string") hints.agentId = scoped.agent_id;
  if (scoped.project_key === null || typeof scoped.project_key === "string") {
    hints.projectKey = scoped.project_key as string | null;
  }
  if (Array.isArray(scoped.tags)) {
    hints.tags = scoped.tags.filter((t): t is string => typeof t === "string");
  }
  if (Array.isArray(scoped.applies_to)) {
    hints.appliesTo = scoped.applies_to.filter((a): a is string => typeof a === "string");
  }
  return hints;
}

const remember: ToolDefinition = {
  name: "remember",
  description:
    "Save a durable memory. Protected memories are routed to the proposal " +
    "queue for owner review. Caller-supplied `is_global` / `requires_approval` " +
    "are ignored (spec §4.1–§4.4).",
  inputSchema: memoryInputSchema(),
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    // conv_id was a domain-routing signal, not a memory field.
    delete scoped.conv_id;

    // Inbox cutover: when intake is enabled (the dashboard setting
    // `curator.intake.enabled`, spec 043 D-E), `remember` is a fire-and-forget
    // submission — stored raw in the inbox and filed asynchronously by the
    // consolidator (navigate→judge→edit), preserving the submitter's scope via
    // hints. Otherwise the legacy direct write.
    if (isConsolidatorEnabled(store)) {
      const title = typeof scoped.title === "string" ? scoped.title : "";
      const body = typeof scoped.body === "string" ? scoped.body : "";
      const text = title ? `${title}\n\n${body}` : body;
      // An empty submission has nothing to consolidate. Fall through to the
      // legacy write (which terminally files an "Untitled memory") rather than
      // enqueueing an empty inbox item — navigate→judge can't make a plan from
      // empty text, so it would only loop on the reaper TTL.
      if (text.trim()) {
        store.submitToInbox(text, submissionHints(scoped));
        return textResult(
          "Noted — queued for consolidation. The consolidator will file it into your memory shortly.",
        );
      }
    }

    const result = store.createMemory(scoped, {});
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

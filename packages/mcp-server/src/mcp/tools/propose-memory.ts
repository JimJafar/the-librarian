import { type InboxSubmissionHints, isIntakeEnabled } from "@librarian/core";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { scopeAgentArgs } from "../visibility.js";
import { memoryInputSchema } from "./schemas.js";

/**
 * The submitter's filing/ownership hints plus the force-proposal directive (ADR
 * 0004) — so a consolidated propose_memory submission keeps its scope AND always
 * terminates as a proposal, never an auto-apply.
 */
function submissionHints(scoped: Record<string, unknown>): InboxSubmissionHints {
  const hints: InboxSubmissionHints = { forceProposal: true };
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

const proposeMemory: ToolDefinition = {
  name: "propose_memory",
  description: "Create a proposed memory for review.",
  inputSchema: memoryInputSchema(),
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    // conv_id is a domain-routing signal, not a memory field (mirrors `remember`).
    delete scoped.conv_id;

    // Inbox cutover (ADR 0004): when intake is enabled, propose_memory submits to
    // the consolidator inbox with a force-proposal directive. The curator dedups
    // and merges it (navigate→judge) like any submission, but always terminates it
    // as a PROPOSAL — never an auto-apply. This closes the spec-043 gap where
    // propose_memory bypassed the curator entirely (no merge, no under-eval gate).
    // Otherwise the legacy direct write — which now surfaces detected duplicates.
    if (isIntakeEnabled(store)) {
      const title = typeof scoped.title === "string" ? scoped.title : "";
      const body = typeof scoped.body === "string" ? scoped.body : "";
      const text = title ? `${title}\n\n${body}` : body;
      // An empty submission has nothing to consolidate — fall through to the legacy
      // write rather than enqueueing an empty inbox item (parity with `remember`).
      if (text.trim()) {
        store.submitToInbox(text, submissionHints(scoped));
        return textResult(
          "Noted — queued for review. The curator will dedupe it and file a proposal shortly.",
        );
      }
    }

    const result = store.createMemory({ ...scoped, status: "proposed" }, { status: "proposed" });
    const duplicateText = result.duplicates?.length
      ? `\n\nPossible duplicates:\n${result.duplicates
          .map((memory) => `- ${memory.title}: ${memory.body}`)
          .join("\n")}`
      : "";
    return textResult(
      `Memory proposal saved.\n\n${result.memory.title}: ${result.memory.body}${duplicateText}`,
    );
  },
};

export default proposeMemory;

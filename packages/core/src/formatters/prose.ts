import type { HandoverPayload } from "./index.js";

export function renderHandoverProse(handover: HandoverPayload): string {
  const parts: string[] = [];
  const project = handover.project_key ? ` on project ${handover.project_key}` : "";
  parts.push(
    `Session "${handover.title}" (${handover.id})${project} is currently ${handover.status}.`,
  );
  const origin = handover.created_in_harness || "unknown harness";
  const dest = handover.current_harness || "unknown harness";
  parts.push(`Started in ${origin}; continuing in ${dest}.`);
  if (handover.start_summary) parts.push(`Goal: ${handover.start_summary}`);
  if (handover.rolling_summary) parts.push(`Current state: ${handover.rolling_summary}`);
  if (handover.end_summary) parts.push(`End summary: ${handover.end_summary}`);
  if (handover.decisions.length) parts.push(`Decisions so far: ${handover.decisions.join("; ")}.`);
  if (handover.files_touched.length)
    parts.push(`Files touched: ${handover.files_touched.join(", ")}.`);
  if (handover.commands_run.length)
    parts.push(`Commands run: ${handover.commands_run.join("; ")}.`);
  if (handover.open_questions.length)
    parts.push(`Open questions: ${handover.open_questions.join("; ")}.`);
  if (handover.next_steps.length) parts.push(`Next steps: ${handover.next_steps.join("; ")}.`);
  parts.push(
    "Treat this as session evidence, not durable memory; use remember/propose_memory for durable facts.",
  );
  return parts.join(" ");
}

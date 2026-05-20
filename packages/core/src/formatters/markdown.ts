import type { HandoverPayload } from "./index.js";

export function renderHandoverMarkdown(handover: HandoverPayload): string {
  const lines: string[] = [
    "# Librarian Session Handover",
    "",
    `Session: ${handover.title}`,
    `ID: ${handover.id}`,
    `Project: ${handover.project_key || "(none)"}`,
    `Status: ${handover.status}`,
    `Created in: ${formatLocation(handover.created_in_harness, handover.created_source_ref)}`,
    `Continuing in: ${formatLocation(handover.current_harness, handover.current_source_ref)}`,
    `Last activity: ${handover.last_activity_at || "(unknown)"}`,
    "",
    "## Goal",
    handover.start_summary || "(no start summary recorded)",
    "",
    "## Current Summary",
    handover.rolling_summary || "(no rolling summary recorded)",
  ];
  if (handover.end_summary) {
    lines.push("", "## End Summary", handover.end_summary);
  }
  if (handover.decisions.length) {
    lines.push("", "## Decisions", ...handover.decisions.map((item) => `- ${item}`));
  }
  if (handover.files_touched.length) {
    lines.push("", "## Files / Artefacts", ...handover.files_touched.map((item) => `- ${item}`));
  }
  if (handover.commands_run.length) {
    lines.push("", "## Commands / Checks", ...handover.commands_run.map((item) => `- ${item}`));
  }
  if (handover.open_questions.length) {
    lines.push("", "## Open Questions", ...handover.open_questions.map((item) => `- ${item}`));
  }
  if (handover.next_steps.length) {
    lines.push(
      "",
      "## Next Steps",
      ...handover.next_steps.map((item, index) => `${index + 1}. ${item}`),
    );
  }
  lines.push(
    "",
    "## Boundaries",
    "- Treat this as session evidence, not automatically true durable memory.",
    "- Use The Librarian `remember`/`propose_memory` only for durable facts.",
  );
  return lines.join("\n");
}

function formatLocation(harness: string | null, sourceRef: string | null): string {
  const h = harness || "(unknown)";
  if (sourceRef) return `${h} / ${sourceRef}`;
  return h;
}

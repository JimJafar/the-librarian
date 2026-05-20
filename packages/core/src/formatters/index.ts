import { renderHandoverMarkdown } from "./markdown.js";
import { renderHandoverProse } from "./prose.js";

export interface HandoverPayload {
  id: string;
  title: string;
  project_key: string | null;
  status: string;
  visibility: string;
  created_in_harness: string | null;
  created_source_ref: string | null;
  current_harness: string | null;
  current_source_ref: string | null;
  current_cwd: string | null;
  start_summary: string | null;
  rolling_summary: string | null;
  end_summary: string | null;
  decisions: string[];
  files_touched: string[];
  commands_run: string[];
  open_questions: string[];
  next_steps: string[];
  tags: string[];
  last_activity_at: string;
}

export function renderHandover(handover: HandoverPayload, format: string): string {
  if (format === "prose") return renderHandoverProse(handover);
  return renderHandoverMarkdown(handover);
}

export interface RecallItem {
  title: string;
  body: string;
}

export function formatRecall(
  memories: RecallItem[],
  heading: string = "Relevant Memories",
): string {
  if (!memories.length) return `${heading}\n\nNo relevant memories found.`;
  return `${heading}\n\n${memories.map((memory) => `- ${memory.title}: ${memory.body}`).join("\n")}`;
}

export { renderHandoverMarkdown, renderHandoverProse };

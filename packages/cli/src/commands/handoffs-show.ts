import type { Command } from "./_shared.js";

export const handoffsShow: Command = (store, positionals, flags) => {
  const [handoffId] = positionals;
  if (!handoffId) {
    return { stdout: "Usage: the-librarian handoffs show <handoff_id>", exitCode: 1 };
  }
  const detail = store.handoffs.getById(handoffId);
  if (!detail) return { stdout: `No handoff for id ${handoffId}.`, exitCode: 1 };
  if (flags.json) return { stdout: JSON.stringify(detail, null, 2), exitCode: 0 };
  const lines = [
    `handoff_id:       ${detail.handoff_id}`,
    `title:            ${detail.title}`,
    `created_at:       ${detail.created_at}`,
    `created_by:       ${detail.created_by_agent_id ?? "—"}`,
    `created_in:       ${detail.created_in_harness ?? "—"}`,
    `project_key:      ${detail.project_key ?? "—"}`,
    `cwd:              ${detail.cwd ?? "—"}`,
    `claimed_at:       ${detail.claimed_at ?? "(unclaimed)"}`,
    "",
    detail.document_md,
  ];
  return { stdout: lines.join("\n"), exitCode: 0 };
};

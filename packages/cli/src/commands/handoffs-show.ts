import type { Command } from "./_shared.js";

export const handoffsShow: Command = (store, positionals, flags) => {
  const [handoffId] = positionals;
  if (!handoffId) {
    return { stdout: "Usage: the-librarian handoffs show <handoff_id>", exitCode: 1 };
  }
  // The store doesn't expose a getById — `show` is rare enough that a SELECT
  // here is the simplest path. Renaming to a method is a follow-up if a second
  // consumer appears.
  const row = store.db.prepare("SELECT * FROM handoffs WHERE id = ?").get(handoffId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return { stdout: `No handoff for id ${handoffId}.`, exitCode: 1 };
  if (flags.json) return { stdout: JSON.stringify(row, null, 2), exitCode: 0 };
  const lines = [
    `handoff_id:       ${row.id}`,
    `title:            ${row.title}`,
    `created_at:       ${row.created_at}`,
    `created_by:       ${row.created_by_agent_id ?? "—"}`,
    `created_in:       ${row.created_in_harness ?? "—"}`,
    `project_key:      ${row.project_key ?? "—"}`,
    `cwd:              ${row.cwd ?? "—"}`,
    `domain:           ${row.domain}`,
    `claimed_at:       ${row.claimed_at ?? "(unclaimed)"}`,
    "",
    row.document_md as string,
  ];
  return { stdout: lines.join("\n"), exitCode: 0 };
};

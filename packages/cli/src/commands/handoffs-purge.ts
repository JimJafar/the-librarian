import type { Command } from "./_shared.js";

export const handoffsPurge: Command = (store, positionals, flags) => {
  if (flags.admin !== true) {
    return {
      stdout: "handoffs purge is admin-only. Re-run with --admin.",
      exitCode: 1,
    };
  }
  const [handoffId] = positionals;
  if (!handoffId) {
    return { stdout: "Usage: the-librarian handoffs purge <handoff_id> --admin", exitCode: 1 };
  }
  const removed = store.handoffs.purge(handoffId);
  if (!removed) return { stdout: `No handoff for id ${handoffId}.`, exitCode: 1 };
  return { stdout: `Purged ${handoffId}.`, exitCode: 0 };
};

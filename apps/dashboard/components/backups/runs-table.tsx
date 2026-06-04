// Read-only backup run health (automated-backups A6): trigger, status, the target
// repo, when, and the error / pushed-commit detail. `run.error` is rendered
// verbatim — it's safe because the git-push token is scrubbed from errors upstream,
// and React escapes the text.

import type { BackupRun } from "@librarian/core";

function fmt(ts: string | null): string {
  return ts ? new Date(ts).toLocaleString() : "—";
}

export function BackupRunsTable({ runs }: { runs: BackupRun[] }) {
  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">No backup runs yet.</p>;
  }
  return (
    <table className="w-full text-left text-sm" aria-label="Backup runs">
      <thead className="text-xs text-muted-foreground">
        <tr>
          <th className="py-2 pr-4 font-medium">Trigger</th>
          <th className="py-2 pr-4 font-medium">Status</th>
          <th className="py-2 pr-4 font-medium">Repo</th>
          <th className="py-2 pr-4 font-medium">When</th>
          <th className="py-2 font-medium">Detail</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.id} className="border-t align-top">
            <td className="py-2 pr-4">{run.trigger}</td>
            <td
              className={`py-2 pr-4 ${run.status === "error" ? "text-destructive" : run.status === "ok" ? "text-green-600" : ""}`}
            >
              {run.status}
            </td>
            <td className="py-2 pr-4">{run.target ?? "—"}</td>
            <td className="py-2 pr-4 font-mono text-xs">{fmt(run.created_at)}</td>
            <td className="py-2">
              {run.error ?? (run.bundle ? `pushed ${run.bundle.slice(0, 7)}` : "—")}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

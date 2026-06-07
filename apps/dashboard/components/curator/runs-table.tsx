// Read-only curation run history (spec §13 observability): trigger, status, when,
// summary (per-action counts), token usage, model.

import type { CurationRun } from "@librarian/core";

function fmt(ts: string | null): string {
  return ts ? new Date(ts).toLocaleString() : "—";
}

export function GroomingRunsTable({ runs }: { runs: CurationRun[] }) {
  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">No curation runs yet.</p>;
  }
  return (
    <table className="w-full text-left text-sm" aria-label="Curation runs">
      <thead className="text-xs text-muted-foreground">
        <tr>
          <th className="py-2 pr-4 font-medium">Trigger</th>
          <th className="py-2 pr-4 font-medium">Status</th>
          <th className="py-2 pr-4 font-medium">Started</th>
          <th className="py-2 pr-4 font-medium">Summary</th>
          <th className="py-2 pr-4 font-medium">Tokens (in/out)</th>
          <th className="py-2 font-medium">Model</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.id} className="border-t align-top">
            <td className="py-2 pr-4">{run.trigger}</td>
            <td className="py-2 pr-4">{run.status}</td>
            <td className="py-2 pr-4 font-mono text-xs">{fmt(run.started_at)}</td>
            <td className="py-2 pr-4">{run.summary ?? run.error ?? "—"}</td>
            <td className="py-2 pr-4 font-mono text-xs">
              {run.usage_input_tokens}/{run.usage_output_tokens}
            </td>
            <td className="py-2 font-mono text-xs">{run.model_name ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Read-only curation run history (spec §13 observability) — editorial
// rebuild on ui-v2 Table primitives.

import type { CurationRun } from "@librarian/core";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui-v2/table";

function fmt(ts: string | null): string {
  return ts ? new Date(ts).toLocaleString() : "—";
}

export function GroomingRunsTable({ runs }: { runs: CurationRun[] }) {
  if (runs.length === 0) {
    return <p className="text-sm text-foreground/60">No curation runs yet.</p>;
  }
  return (
    <Table aria-label="Curation runs">
      <TableHeader>
        <TableRow>
          <TableHead>Trigger</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Started</TableHead>
          <TableHead>Summary</TableHead>
          <TableHead>Tokens (in/out)</TableHead>
          <TableHead>Model</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <TableRow key={run.id} className="align-top">
            <TableCell>{run.trigger}</TableCell>
            <TableCell>{run.status}</TableCell>
            <TableCell className="font-mono text-xs text-foreground/70">
              {fmt(run.started_at)}
            </TableCell>
            <TableCell className="text-foreground/80">{run.summary ?? run.error ?? "—"}</TableCell>
            <TableCell className="font-mono text-xs text-foreground/70">
              {run.usage_input_tokens}/{run.usage_output_tokens}
            </TableCell>
            <TableCell className="font-mono text-xs text-foreground/70">
              {run.model_name ?? "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

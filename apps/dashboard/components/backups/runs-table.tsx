// Read-only backup run health (automated-backups A6) — editorial rebuild
// on ui-v2 Table primitives. `run.error` is rendered verbatim — safe
// because the git-push token is scrubbed from errors upstream, and React
// escapes the text.

import type { BackupRun } from "@librarian/core";
import { Pill } from "@/components/ui-v2/pill";
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

function StatusCell({ status }: { status: string }) {
  switch (status) {
    case "ok":
      return <Pill variant="accent">ok</Pill>;
    case "error":
      return <span className="font-mono text-xs text-destructive">error</span>;
    default:
      return <span className="font-mono text-xs text-foreground/70">{status}</span>;
  }
}

export function BackupRunsTable({ runs }: { runs: BackupRun[] }) {
  if (runs.length === 0) {
    return <p className="text-sm text-foreground/60">No backup runs yet.</p>;
  }
  return (
    <Table aria-label="Backup runs">
      <TableHeader>
        <TableRow>
          <TableHead>Trigger</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Repo</TableHead>
          <TableHead>When</TableHead>
          <TableHead>Detail</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <TableRow key={run.id} className="align-top">
            <TableCell>{run.trigger}</TableCell>
            <TableCell>
              <StatusCell status={run.status} />
            </TableCell>
            <TableCell className="font-mono text-xs text-foreground/70">
              {run.target ?? "—"}
            </TableCell>
            <TableCell className="font-mono text-xs text-foreground/70">
              {fmt(run.created_at)}
            </TableCell>
            <TableCell
              className={run.status === "error" ? "text-destructive" : "text-foreground/80"}
            >
              {run.error ?? (run.bundle ? `pushed ${run.bundle.slice(0, 7)}` : "—")}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

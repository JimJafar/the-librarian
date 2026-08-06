import type { ChronicleRun } from "@librarian/core";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui-v2/table";

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatDate(value: string | null): string {
  return value ? dateTime.format(new Date(value)) : "—";
}

function words(value: string): string {
  return value.replace(/_/g, " ");
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${milliseconds}ms`;
  const seconds = milliseconds / 1000;
  return seconds < 60
    ? `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
    : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function narrativeLabel(run: ChronicleRun): string {
  if (run.narrative === "generated") return "Narrated";
  if (run.narrative === "failed") return "Digest only (narration failed)";
  return "Digest only";
}

export function ChronicleRunsTable({ runs }: { runs: ChronicleRun[] }) {
  if (runs.length === 0) {
    return (
      <p className="text-sm text-foreground/60">
        No Chronicle entries yet. Run it now to write a partial digest for this week.
      </p>
    );
  }

  return (
    <Table aria-label="Chronicle runs" className="min-w-[880px]">
      <TableHeader>
        <TableRow>
          <TableHead>Week</TableHead>
          <TableHead>Shelf</TableHead>
          <TableHead>Trigger</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Output</TableHead>
          <TableHead>Started</TableHead>
          <TableHead>Duration</TableHead>
          <TableHead>Tokens</TableHead>
          <TableHead>Model</TableHead>
          <TableHead>Entry</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <TableRow key={run.id} className="align-top">
            <TableCell className="font-mono text-xs">
              {run.iso_week}
              {run.partial ? <span className="ml-1 text-foreground/55">partial</span> : null}
            </TableCell>
            <TableCell>{run.shelf_label ?? run.shelf_id}</TableCell>
            <TableCell className="capitalize">{run.trigger}</TableCell>
            <TableCell>
              <span className="capitalize">{run.status}</span>
              {run.error ? (
                <span className="block text-xs text-destructive">{words(run.error)}</span>
              ) : null}
            </TableCell>
            <TableCell>{narrativeLabel(run)}</TableCell>
            <TableCell className="whitespace-nowrap font-mono text-xs text-foreground/70">
              <time dateTime={run.started_at ?? run.created_at}>
                {formatDate(run.started_at ?? run.created_at)}
              </time>
            </TableCell>
            <TableCell className="font-mono text-xs text-foreground/70">
              {formatDuration(run.duration_ms)}
            </TableCell>
            <TableCell className="font-mono text-xs text-foreground/70">
              {run.usage_input_tokens}/{run.usage_output_tokens}
            </TableCell>
            <TableCell className="font-mono text-xs text-foreground/70">
              {run.model_name ?? "—"}
            </TableCell>
            <TableCell className="max-w-72 font-mono text-xs text-foreground/70">
              {run.path ?? "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

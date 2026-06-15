"use client";

// Read-only intake decision history (spec 043 C1 / C5b) — editorial
// rebuild. Each run row expands to reveal its per-operation decisions
// (loaded on demand). Outcome cells use the brand vocabulary: verdigris
// for applied, mono foreground for proposed, foreground/55 for skipped,
// destructive for failed.

import type { IntakeOperation, IntakeRun } from "@librarian/core";
import { useState, useTransition } from "react";
import type { LoadOperationsResult } from "@/app/curator/actions";
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

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 12 12"
      className={`h-2.5 w-2.5 shrink-0 text-foreground/60 transition-transform ${
        open ? "rotate-90" : ""
      }`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 3 8 6 4 9" />
    </svg>
  );
}

function OutcomeCell({ outcome }: { outcome: string }) {
  switch (outcome) {
    case "applied":
      return <Pill variant="accent">applied</Pill>;
    case "proposed":
      return <span className="font-mono text-xs text-foreground">{outcome}</span>;
    case "skipped":
      return <span className="font-mono text-xs text-foreground/55">{outcome}</span>;
    case "failed":
      return <span className="font-mono text-xs text-destructive">{outcome}</span>;
    default:
      return <span className="font-mono text-xs text-foreground/70">{outcome}</span>;
  }
}

function OperationsDetail({ operations }: { operations: IntakeOperation[] }) {
  if (operations.length === 0) {
    return <p className="px-2 py-2 text-sm text-foreground/60">No decisions recorded.</p>;
  }
  return (
    <Table aria-label="Intake decisions">
      <TableHeader>
        <TableRow>
          <TableHead>Action</TableHead>
          <TableHead>Outcome</TableHead>
          <TableHead>Confidence</TableHead>
          <TableHead>Rationale</TableHead>
          <TableHead>Source</TableHead>
          <TableHead>Target</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {operations.map((op) => (
          <TableRow key={op.id} className="align-top">
            <TableCell className="font-mono text-xs">{op.action}</TableCell>
            <TableCell>
              <OutcomeCell outcome={op.outcome} />
            </TableCell>
            <TableCell className="font-mono text-xs">{op.confidence.toFixed(2)}</TableCell>
            <TableCell className="text-foreground/80">{op.rationale || "—"}</TableCell>
            <TableCell className="font-mono text-xs text-foreground/70">
              {op.source_id ?? "—"}
            </TableCell>
            <TableCell className="font-mono text-xs text-foreground/70">
              {op.target_id ?? "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RunRow({
  run,
  onLoadOperations,
}: {
  run: IntakeRun;
  onLoadOperations: (runId: string) => Promise<LoadOperationsResult>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [operations, setOperations] = useState<IntakeOperation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && operations === null && !pending) {
      startTransition(async () => {
        const result = await onLoadOperations(run.id);
        if (result.ok) setOperations(result.operations);
        else setError(result.error);
      });
    }
  };

  return (
    <>
      <TableRow className="align-top">
        <TableCell>
          <button
            type="button"
            onClick={toggle}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} decisions for run ${run.id}`}
            className="inline-flex items-center gap-1.5 text-left text-foreground transition-colors hover:text-ink-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent"
          >
            <Chevron open={expanded} />
            <span>{run.trigger}</span>
          </button>
        </TableCell>
        <TableCell>{run.status}</TableCell>
        <TableCell className="font-mono text-xs text-foreground/70">
          {fmt(run.started_at)}
        </TableCell>
        <TableCell className="text-foreground/80">{run.summary ?? run.error ?? "—"}</TableCell>
        <TableCell className="font-mono text-xs text-foreground/70">{run.consolidated}</TableCell>
      </TableRow>
      {expanded ? (
        <TableRow className="bg-foreground/[0.02]">
          <TableCell colSpan={5} className="px-2 py-2">
            {pending ? (
              <p className="px-2 py-1 text-sm text-foreground/60">Loading decisions…</p>
            ) : error ? (
              <p role="alert" className="px-2 py-1 text-sm text-destructive">
                Error: {error}
              </p>
            ) : operations ? (
              <OperationsDetail operations={operations} />
            ) : null}
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

export function IntakeRunsTable({
  runs,
  onLoadOperations,
}: {
  runs: IntakeRun[];
  onLoadOperations: (runId: string) => Promise<LoadOperationsResult>;
}) {
  if (runs.length === 0) {
    return <p className="text-sm text-foreground/60">No intake runs yet.</p>;
  }
  return (
    <Table aria-label="Intake runs">
      <TableHeader>
        <TableRow>
          <TableHead>Trigger</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Started</TableHead>
          <TableHead>Summary</TableHead>
          <TableHead>Consolidated</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <RunRow key={run.id} run={run} onLoadOperations={onLoadOperations} />
        ))}
      </TableBody>
    </Table>
  );
}

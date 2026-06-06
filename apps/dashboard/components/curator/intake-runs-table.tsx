"use client";

// Read-only intake (consolidation) decision history (spec 043 C1 / C5b). Unlike
// grooming's runs table (token/model-centric per curation pass), an intake run is
// a whole-inbox sweep whose VALUE is the C1 decision log — what the judge decided
// for each item and how it was realised. So each run row expands to reveal its
// per-operation decisions: action / outcome / confidence / rationale (loaded on
// demand to keep the page payload small). source/target ids are shown so an admin
// can trace a decision back to the inbox item + the memory it touched.

import type { ConsolidationOperation, ConsolidationRun } from "@librarian/core";
import { useState, useTransition } from "react";
import type { LoadOperationsResult } from "@/app/curator/actions";

function fmt(ts: string | null): string {
  return ts ? new Date(ts).toLocaleString() : "—";
}

const outcomeTone: Record<string, string> = {
  applied: "text-green-600",
  proposed: "text-blue-600",
  skipped: "text-muted-foreground",
  failed: "text-destructive",
};

function OperationsDetail({ operations }: { operations: ConsolidationOperation[] }) {
  if (operations.length === 0) {
    return <p className="px-2 py-2 text-sm text-muted-foreground">No decisions recorded.</p>;
  }
  return (
    <table className="w-full text-left text-xs" aria-label="Intake decisions">
      <thead className="text-muted-foreground">
        <tr>
          <th className="py-1 pr-4 font-medium">Action</th>
          <th className="py-1 pr-4 font-medium">Outcome</th>
          <th className="py-1 pr-4 font-medium">Confidence</th>
          <th className="py-1 pr-4 font-medium">Rationale</th>
          <th className="py-1 pr-4 font-medium">Source</th>
          <th className="py-1 font-medium">Target</th>
        </tr>
      </thead>
      <tbody>
        {operations.map((op) => (
          <tr key={op.id} className="border-t align-top">
            <td className="py-1 pr-4 font-mono">{op.action}</td>
            <td className={`py-1 pr-4 font-medium ${outcomeTone[op.outcome] ?? ""}`}>
              {op.outcome}
            </td>
            <td className="py-1 pr-4 font-mono">{op.confidence.toFixed(2)}</td>
            <td className="py-1 pr-4">{op.rationale || "—"}</td>
            <td className="py-1 pr-4 font-mono">{op.source_id ?? "—"}</td>
            <td className="py-1 font-mono">{op.target_id ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RunRow({
  run,
  onLoadOperations,
}: {
  run: ConsolidationRun;
  onLoadOperations: (runId: string) => Promise<LoadOperationsResult>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [operations, setOperations] = useState<ConsolidationOperation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    // Lazy-load the decisions the first time this run is opened.
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
      <tr className="border-t align-top">
        <td className="py-2 pr-4">
          <button
            type="button"
            onClick={toggle}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} decisions for run ${run.id}`}
            className="text-left underline-offset-2 hover:underline"
          >
            {expanded ? "▾" : "▸"} {run.trigger}
          </button>
        </td>
        <td className="py-2 pr-4">{run.status}</td>
        <td className="py-2 pr-4 font-mono text-xs">{fmt(run.started_at)}</td>
        <td className="py-2 pr-4">{run.summary ?? run.error ?? "—"}</td>
        <td className="py-2 font-mono text-xs">{run.consolidated}</td>
      </tr>
      {expanded ? (
        <tr className="border-t bg-background/50">
          <td colSpan={5} className="px-2 py-1">
            {pending ? (
              <p className="px-2 py-2 text-sm text-muted-foreground">Loading decisions…</p>
            ) : error ? (
              <p className="px-2 py-2 text-sm text-destructive">Error: {error}</p>
            ) : operations ? (
              <OperationsDetail operations={operations} />
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function IntakeRunsTable({
  runs,
  onLoadOperations,
}: {
  runs: ConsolidationRun[];
  onLoadOperations: (runId: string) => Promise<LoadOperationsResult>;
}) {
  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">No intake runs yet.</p>;
  }
  return (
    <table className="w-full text-left text-sm" aria-label="Intake runs">
      <thead className="text-xs text-muted-foreground">
        <tr>
          <th className="py-2 pr-4 font-medium">Trigger</th>
          <th className="py-2 pr-4 font-medium">Status</th>
          <th className="py-2 pr-4 font-medium">Started</th>
          <th className="py-2 pr-4 font-medium">Summary</th>
          <th className="py-2 font-medium">Consolidated</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <RunRow key={run.id} run={run} onLoadOperations={onLoadOperations} />
        ))}
      </tbody>
    </table>
  );
}

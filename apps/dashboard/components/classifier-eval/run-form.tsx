"use client";

import { useState, useTransition } from "react";
import {
  runClassifierEvalAction,
  type ClassifierEvalActionResult,
  type ClassifierEvalReportSummary,
} from "@/app/(memories)/classifier-eval/actions";

export function ClassifierEvalRunForm() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ClassifierEvalReportSummary | null>(null);

  return (
    <section className="rounded-md border bg-card p-4">
      <h2 className="mb-3 font-semibold">Run evaluation</h2>
      <form
        action={(form: FormData) => {
          setError(null);
          startTransition(async () => {
            const result: ClassifierEvalActionResult = await runClassifierEvalAction(form);
            if (result.ok) {
              setReport(result.report);
            } else {
              setError(result.error);
              setReport(null);
            }
          });
        }}
        className="flex flex-col gap-3 text-sm"
      >
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Endpoint URL</span>
          <input
            name="endpoint"
            type="url"
            required
            placeholder="https://api.openai.com/v1"
            className="rounded border bg-background px-3 py-1.5"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">API token</span>
          <input
            name="token"
            type="password"
            required
            className="rounded border bg-background px-3 py-1.5"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Model id</span>
          <input
            name="model"
            type="text"
            required
            placeholder="gpt-4o-mini"
            className="rounded border bg-background px-3 py-1.5"
          />
        </label>
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Sample size</span>
            <input
              name="sample"
              type="number"
              min={1}
              max={1000}
              defaultValue={10}
              className="w-24 rounded border bg-background px-3 py-1.5"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Category</span>
            <select
              name="category"
              defaultValue="all"
              className="rounded border bg-background px-3 py-1.5"
            >
              <option value="all">All</option>
              <option value="straight">Straight only</option>
              <option value="boundary">Boundary only</option>
            </select>
          </label>
        </div>
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50"
        >
          {pending ? "Running…" : "Run evaluation"}
        </button>
      </form>

      {error ? (
        <p className="mt-4 rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {report ? <ClassifierEvalReportView report={report} /> : null}
    </section>
  );
}

function ClassifierEvalReportView({ report }: { report: ClassifierEvalReportSummary }) {
  const fallbacks = Object.entries(report.fallback_counts);
  return (
    <div className="mt-4 flex flex-col gap-3 rounded border bg-background p-3 text-sm">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">Latest run</h3>
        <span className="text-xs text-muted-foreground">{report.run_id}</span>
      </header>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Provider</dt>
        <dd>{report.provider}</dd>
        <dt className="text-muted-foreground">Model</dt>
        <dd>{report.model}</dd>
        <dt className="text-muted-foreground">Prompt</dt>
        <dd>{report.prompt_version}</dd>
        <dt className="text-muted-foreground">Samples</dt>
        <dd>
          {report.sample_size} ({report.filter})
        </dd>
      </dl>
      <section>
        <h4 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Agreement</h4>
        <ul className="grid grid-cols-3 gap-2 text-xs">
          <li>
            joint: <strong>{(report.agreement.joint * 100).toFixed(1)}%</strong>
          </li>
          <li>
            requires_approval:{" "}
            <strong>{(report.agreement.requires_approval * 100).toFixed(1)}%</strong>
          </li>
          <li>
            is_global: <strong>{(report.agreement.is_global * 100).toFixed(1)}%</strong>
          </li>
        </ul>
      </section>
      <section>
        <h4 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Latency (ms)</h4>
        <ul className="grid grid-cols-4 gap-2 text-xs">
          <li>p50: {report.latency_ms.p50}</li>
          <li>p95: {report.latency_ms.p95}</li>
          <li>p99: {report.latency_ms.p99}</li>
          <li>max: {report.latency_ms.max}</li>
        </ul>
      </section>
      {fallbacks.length > 0 ? (
        <section>
          <h4 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Fallbacks</h4>
          <ul className="text-xs">
            {fallbacks.map(([reason, count]) => (
              <li key={reason}>
                {reason}: {count}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

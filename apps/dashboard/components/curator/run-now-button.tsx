"use client";

import type { ConsolidatorTickResult, CuratorTickResult } from "@librarian/core";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

// --- Result renderers (pure, shape-specific) ----------------------------------
// The {ran:false,reason} skip states are turned into an explicit human notice so
// an admin sees *why* nothing ran (disabled / incomplete config / no token).

const skipLabel = (reason: string) => `Skipped — ${reason.replace(/_/g, " ")}.`;

/** Grooming tick: N of M due slice(s) curated, or a skip reason. */
export function renderGroomingResult(result: CuratorTickResult): string {
  return result.ran
    ? `Ran — ${result.summary.ran} of ${result.summary.due} due slice(s) curated.`
    : skipLabel(result.reason);
}

/** Intake sweep: items consolidated this sweep, or a skip reason. */
export function renderIntakeResult(
  result: ConsolidatorTickResult | { ran: false; reason: "disabled" },
): string {
  return result.ran
    ? `Ran — ${result.summary.consolidated} item(s) consolidated.`
    : skipLabel(result.reason);
}

// A run-now result is either an error or a job-specific result object. The button
// is shape-agnostic: each section supplies a `renderResult` that turns its own
// success/skip result into a human message, so one button drives both the
// grooming tick (CuratorTickResult) and the intake sweep (ConsolidatorTickResult)
// without leaking either shape here. The {ran:false,reason} skip states are
// surfaced via that renderer, never swallowed.
export type RunActionResult<R> = { ok: true; result: R } | { ok: false; error: string };

const defaultLabel = "Run now";

export function RunNowButton<R>({
  onRun,
  renderResult,
  label = defaultLabel,
  ariaLabel,
}: {
  onRun: () => Promise<RunActionResult<R>>;
  renderResult: (result: R) => string;
  label?: string;
  ariaLabel?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const router = useRouter();

  const run = () =>
    startTransition(async () => {
      const res = await onRun();
      if (!res.ok) {
        setMessage(`Error: ${res.error}`);
        return;
      }
      setMessage(renderResult(res.result));
      router.refresh();
    });

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={run}
        disabled={pending}
        aria-label={ariaLabel ?? label}
        className="rounded-md border bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {pending ? "Running…" : label}
      </button>
      {message ? <span className="text-sm text-muted-foreground">{message}</span> : null}
    </div>
  );
}

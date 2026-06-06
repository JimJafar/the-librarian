"use client";

// Addendum-evaluation lifecycle controls (spec 044 D-7 / decisions D-3/4/11). Sits
// in a curator job's section and drives the under-evaluation lifecycle:
//
//   - Accept (D3)      — the new addendum is good; resume auto-apply.
//   - Roll-back (D3)   — the new addendum is bad; restore the prior committed one.
//   - Re-evaluate (D3c, GROOMING ONLY) — batch re-judge the tagged proposals.
//   - Dry-run (D4, GROOMING ONLY)      — preview the current candidate over the
//     corpus WITHOUT committing it (background; the admin polls runs/proposals).
//
// Re-evaluate + Dry-run are NOT rendered for intake (the inbox is consumed on
// apply — not replayable). The Accept/Roll-back lifecycle applies to both jobs.
//
// DISABLED-JOB MESSAGING (D-11): when the job is disabled the chat + addendum
// editor still work (edits commit and take effect when the job is re-enabled), but
// the probation/dry-run controls are INERT with a clear message — never hidden
// silently. Accept/Roll-back stay live (they just flip a status the next enabled
// run reads).

import type { CuratorJob } from "@librarian/core";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type {
  AddendumStateResult,
  DryRunActionResult,
  ReEvaluateResult,
} from "@/app/curator/actions";

const buttonClass =
  "rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50";

export function AddendumLifecycle({
  job,
  status,
  evalVersion,
  enabled,
  candidate,
  onAccept,
  onRollback,
  onReEvaluate,
  onDryRun,
}: {
  job: CuratorJob;
  status: "accepted" | "under_evaluation";
  evalVersion: string | null;
  enabled: boolean;
  // The current addendum draft (right pane) — dry-run previews THIS candidate.
  candidate: string;
  onAccept: (input: { job: CuratorJob }) => Promise<AddendumStateResult>;
  onRollback: (input: { job: CuratorJob }) => Promise<AddendumStateResult>;
  onReEvaluate: (input: { job: CuratorJob }) => Promise<ReEvaluateResult>;
  onDryRun: (input: { candidateAddendum: string }) => Promise<DryRunActionResult>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  // Grooming has the dry-run + re-evaluate escape hatches; intake does not.
  const isGrooming = job === "grooming";
  const underEvaluation = status === "under_evaluation";

  const run = <R,>(action: () => Promise<R>, describe: (result: R) => string) =>
    startTransition(async () => {
      setNotice(null);
      const result = await action();
      setNotice(describe(result));
      router.refresh();
    });

  return (
    <section
      className="flex flex-col gap-3 rounded-md border bg-card p-4"
      aria-label={`${job === "grooming" ? "Grooming" : "Intake"} addendum lifecycle`}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">Addendum status</h3>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            underEvaluation
              ? "bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200"
              : "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-200"
          }`}
        >
          {underEvaluation ? "under evaluation" : "accepted"}
          {underEvaluation && evalVersion ? ` · ${evalVersion.slice(0, 7)}` : ""}
        </span>
      </div>

      {underEvaluation ? (
        <p className="text-xs text-muted-foreground">
          The {job} curator is force-proposing every would-be auto-apply until you accept (or roll
          back) this addendum version.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          The {job} addendum is accepted — the curator auto-applies as configured.
        </p>
      )}

      {!enabled ? (
        <p
          className="rounded-md border border-amber-300/50 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-900/20 dark:text-amber-200"
          role="status"
        >
          {job === "grooming" ? "Grooming" : "Intake"} is disabled — enable it to dry-run /
          evaluate. The chat and addendum editor still work; your edits commit and take effect when
          the job is re-enabled.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={buttonClass}
          disabled={pending || !underEvaluation}
          onClick={() =>
            run(
              () => onAccept({ job }),
              (r) => (r.ok ? "Accepted — auto-apply resumes." : `Error: ${r.error}`),
            )
          }
        >
          Accept
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={pending || !underEvaluation}
          onClick={() =>
            run(
              () => onRollback({ job }),
              (r) => (r.ok ? "Rolled back to the prior addendum." : `Error: ${r.error}`),
            )
          }
        >
          Roll back
        </button>
        {isGrooming ? (
          <>
            <button
              type="button"
              className={buttonClass}
              disabled={pending || !enabled}
              title={enabled ? undefined : "Grooming is disabled — enable it to dry-run."}
              onClick={() =>
                run(
                  () => onDryRun({ candidateAddendum: candidate }),
                  (r) =>
                    r.ok
                      ? "started" in r.result
                        ? "Dry-run started over the corpus — check Recent runs / proposals."
                        : r.result.ran
                          ? `Dry-run ran ${r.result.slicesRun} slice(s).`
                          : `Dry-run skipped — ${r.result.reason.replace(/_/g, " ")}.`
                      : `Error: ${r.error}`,
                )
              }
            >
              Dry-run candidate
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={pending || !enabled || !underEvaluation}
              title={enabled ? undefined : "Grooming is disabled — enable it to evaluate."}
              onClick={() =>
                run(
                  () => onReEvaluate({ job }),
                  (r) =>
                    r.ok
                      ? r.result.reEvaluated
                        ? `Re-evaluated — ${r.result.count} proposal(s) refreshed.`
                        : `Re-evaluate skipped — ${r.result.reason.replace(/_/g, " ")}.`
                      : `Error: ${r.error}`,
                )
              }
            >
              Re-evaluate proposals
            </button>
          </>
        ) : null}
      </div>
      {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}
    </section>
  );
}

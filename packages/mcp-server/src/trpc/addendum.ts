// Addendum evaluation lifecycle admin tRPC procedures (spec 044 PR-3b/3c / D3b+D3c).
//
// When an admin changes a curator job's prompt addendum it goes "under evaluation"
// (spec 044 D-3): the curator force-proposes every would-be auto-apply (D3a) so the
// admin can review the batch before trusting the new addendum. This router exposes
// the two simpler lifecycle actions that END an evaluation:
//
//   - accept: the new addendum is good — set status back to `accepted` so the
//     curator auto-applies again. (setAddendumStatus clears the eval version.)
//   - rollback: the new addendum is bad — restore the addendum file to its PRIOR
//     committed version (undo the under-evaluation change) + commit the
//     restoration (revertable), then set status → accepted.
//
// PLACEMENT: a single shared `addendum` router keyed by `{ job }` rather than
// parallel mutations on each of the per-job `curator` (grooming) + `intake`
// routers. The lifecycle is byte-identical per job (both call the same core
// `setAddendumStatus` / `store.rollbackAddendum` keyed by the job), so duplicating
// it onto two routers would be pure repetition. The per-job routers stay split
// because their OTHER concerns (config shape, runs/ops, run-now) genuinely differ;
// this one does not.
//
// The third action — "Re-evaluate proposals" (D3c) — also lives here, but is
// GROOMING ONLY: it batch re-judges the proposals tagged with the current eval
// version, discarding the stale batch and re-running grooming over their slices
// under the current addendum (the escape hatch when the admin keeps editing the
// addendum and earlier-version proposals go stale). Intake has no re-evaluate: the
// intake input (the inbox) is consumed on apply — not replayable (spec 044 "what's
// there"), so an intake proposal has no original judge input to re-run (the same
// reason intake has no dry-run in D4). For `job: "intake"` the mutation returns a
// clear `intake_not_replayable` result rather than attempting any re-judge.
//
// All admin-gated — there is deliberately NO consumer-agent surface for curation.
// The dashboard buttons that call these land in D7.

import type { CuratorJob, ReEvaluateResult } from "@librarian/core";
import {
  readAddendumStatus,
  reEvaluateGroomingProposals,
  setAddendumStatus,
} from "@librarian/core";
import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

/** The mutation summary returned by `reEvaluate` (grooming runs; intake is unsupported). */
type ReEvaluateSummary = ReEvaluateResult | { reEvaluated: false; reason: "intake_not_replayable" };

// The two curator jobs, the same `{ job }` key the addendum status is namespaced
// over (`curator.<job>.addendum_status`).
const JobInputSchema = z.strictObject({ job: z.enum(["intake", "grooming"]) });

export const addendumRouter = router({
  // Accept the addendum under evaluation: resume auto-apply by setting status back
  // to `accepted` (which clears the eval version). Returns the fresh status.
  accept: adminProcedure.input(JobInputSchema).mutation(({ ctx, input }) => {
    const job: CuratorJob = input.job;
    setAddendumStatus(ctx.store, job, "accepted");
    return readAddendumStatus(ctx.store, job);
  }),

  // Roll back the addendum under evaluation: restore the file to its prior
  // committed version (committed as a revertable roll-back commit), then set status
  // → accepted so auto-apply resumes against the restored addendum. Returns the
  // fresh status plus the roll-back outcome (whether a restoration commit was made
  // and the restored version hash).
  rollback: adminProcedure.input(JobInputSchema).mutation(({ ctx, input }) => {
    const job: CuratorJob = input.job;
    const rollback = ctx.store.rollbackAddendum(job);
    setAddendumStatus(ctx.store, job, "accepted");
    return {
      ...readAddendumStatus(ctx.store, job),
      restored: rollback.restored,
      restoredVersion: rollback.version,
    };
  }),

  // Re-evaluate the proposals tagged with the addendum's current eval version
  // (GROOMING ONLY). Grooming: discard that version's stale proposals and re-run
  // grooming over their slices under the current addendum, producing a fresh,
  // re-tagged batch (the escape hatch — see the module header). Intake: NOT
  // replayable (the inbox is consumed on apply), so return a clear unsupported
  // result rather than attempting any re-judge. Returns a summary.
  reEvaluate: adminProcedure
    .input(JobInputSchema)
    .mutation(async ({ ctx, input }): Promise<ReEvaluateSummary> => {
      if (input.job === "intake") {
        // Intake input is consumed on apply — there is no original submission to
        // re-judge. The D7 dashboard simply won't offer the button for intake.
        return { reEvaluated: false, reason: "intake_not_replayable" };
      }
      return reEvaluateGroomingProposals({ store: ctx.store });
    }),
});

// Addendum evaluation lifecycle admin tRPC procedures (spec 044 PR-3b / Task D3b).
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
// this one does not. (The "Re-evaluate proposals" action — D3c — will join here.)
//
// All admin-gated — there is deliberately NO consumer-agent surface for curation.
// The dashboard buttons that call these land in D7.

import type { CuratorJob } from "@librarian/core";
import { readAddendumStatus, setAddendumStatus } from "@librarian/core";
import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

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
});

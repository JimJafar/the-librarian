// Curator addendum admin tRPC procedures (spec 044 D-1, simplified by rethink D4).
//
// Each curator job (intake / grooming) has a git-committed prompt addendum
// (`.curator/<job>-addendum.md`). Edits apply IMMEDIATELY — the next run of the
// job reads the new text; there is no evaluation lifecycle (rethink D4 deleted
// it: git history is the version trail). The surface is deliberately small:
//
//   - get:      a job's committed addendum text + its git version.
//   - set:      commit a new addendum (the 2 KB cap is enforced in core).
//   - rollback: restore the file to its prior committed version, as a new
//     revertable commit (D4: git is the rollback).
//
// PLACEMENT: a single shared `addendum` router keyed by `{ job }` rather than
// parallel mutations on each of the per-job `grooming` + `intake` routers — the
// behaviour is byte-identical per job. All admin-gated; there is deliberately NO
// consumer-agent surface for curation.

import type { CuratorJob } from "@librarian/core";
import { readJobAddendum, setJobAddendum } from "@librarian/core";
import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

// The two curator jobs the addendum files are keyed over.
const JobInputSchema = z.strictObject({ job: z.enum(["intake", "grooming"]) });

// Set-addendum input: the new committed addendum text for a job. The hard 2 KB
// cap is enforced by core's setJobAddendum (which throws over the limit) — the
// dashboard editor + chat condense loop sit in front of it as soft guards.
const SetAddendumInputSchema = z.strictObject({
  job: z.enum(["intake", "grooming"]),
  content: z.string(),
});

export const addendumRouter = router({
  // Read a job's committed addendum text + its git version. The dashboard editor
  // populates from this.
  get: adminProcedure
    .input(JobInputSchema)
    .query(({ ctx, input }) => readJobAddendum(ctx.store, input.job)),

  // Commit a new addendum for a job — it applies immediately (rethink D4): the
  // job's next run reads the new text. Works whether the job is enabled or not
  // (the editor still works for a disabled job; the edit takes effect when the
  // job next runs). The 2 KB cap is enforced by setJobAddendum (throws over-cap).
  set: adminProcedure.input(SetAddendumInputSchema).mutation(({ ctx, input }) => {
    const job: CuratorJob = input.job;
    return setJobAddendum(ctx.store, job, input.content);
  }),

  // Roll the addendum back to its prior committed version (committed as a new,
  // revertable roll-back commit — never history rewrite). Returns the roll-back
  // outcome plus the fresh addendum state.
  rollback: adminProcedure.input(JobInputSchema).mutation(({ ctx, input }) => {
    const job: CuratorJob = input.job;
    const rollback = ctx.store.rollbackAddendum(job);
    return {
      ...readJobAddendum(ctx.store, job),
      restored: rollback.restored,
      restoredVersion: rollback.version,
    };
  }),
});

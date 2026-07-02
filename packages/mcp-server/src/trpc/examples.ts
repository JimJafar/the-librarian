// Intake examples-document admin tRPC procedures (proposal-review rework
// 2026-07-01, F4 / D3).
//
// ONE curator-distilled, git-committed document (`.curator/intake-examples.md`)
// of rejected-submission examples that rides the intake prompt whole (D7) — a
// SIBLING of the addendum (separate provenance: curator-distilled teaching
// material, not operator steering; separate budget: the
// curator.intake.examples_max_bytes knob, default 4096). Edits apply
// immediately; git history is the version trail and rollback is a new
// revertable commit — the same simplified lifecycle as the addendum (D4).
//
//   - get:      the committed examples text + its git version.
//   - set:      commit a new document (the byte cap is enforced in core —
//     setIntakeExamples throws a teaching error over-cap).
//   - rollback: restore the prior committed version as a new commit.
//
// The `distill` mutation (the "Reject & make an example" flow's curator call)
// is added by its own slice (spec task 7). All admin-gated; deliberately no
// consumer-agent surface.

import { readIntakeExamples, setIntakeExamples } from "@librarian/core";
import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

const SetExamplesInputSchema = z.strictObject({ content: z.string() });

export const examplesRouter = router({
  // The committed examples text + its git version. The dashboard viewer/teach
  // dialog populates from this.
  get: adminProcedure.query(({ ctx }) => readIntakeExamples(ctx.store)),

  // Commit a new examples document — applies on the next intake sweep. The
  // byte cap (curator.intake.examples_max_bytes, default 4096) is enforced by
  // core's setIntakeExamples, which throws a teaching error over-cap.
  set: adminProcedure
    .input(SetExamplesInputSchema)
    .mutation(({ ctx, input }) => setIntakeExamples(ctx.store, input.content)),

  // Roll the document back to its prior committed version (a new, revertable
  // roll-back commit — never history rewrite). Returns the outcome plus the
  // fresh document state, mirroring addendum.rollback.
  rollback: adminProcedure.mutation(({ ctx }) => {
    const rollback = ctx.store.rollbackIntakeExamples();
    return {
      ...readIntakeExamples(ctx.store),
      restored: rollback.restored,
      restoredVersion: rollback.version,
    };
  }),
});

// Memory-curator admin tRPC procedures (memory-curator spec §7.1 / §13).
//
// The admin cockpit's typed surface: read/update the curator's NON-LLM config
// (enable flag, schedule, auto-apply posture, prompt addendum), read-only run +
// operation observability, and the run-now control. All admin-gated — there is
// deliberately NO consumer-agent surface for curation (§12). The LLM connection
// is no longer part of this surface — named providers + per-consumer model
// selection live under the `llm` router (042 §4).

import type { CuratorConfigPatch, ListCurationRunsInput } from "@librarian/core";
import {
  CuratorConfigPatchSchema,
  readCuratorConfig,
  runCuratorTick,
  writeCuratorConfig,
} from "@librarian/core";
import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

const ListRunsInputSchema = z.strictObject({
  status: z.string().optional(),
  trigger: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
});

export const curatorRouter = router({
  // Current NON-LLM curator config.
  config: adminProcedure.query(({ ctx }) => readCuratorConfig(ctx.store)),

  // Update config; returns the fresh readable config. writeCuratorConfig validates
  // (addendum size, confidence range, interval).
  setConfig: adminProcedure.input(CuratorConfigPatchSchema).mutation(({ ctx, input }) => {
    // Cast at the validated boundary: Zod `.optional()` infers `T | undefined`,
    // which the patch type (optional-key, not undefined-value) rejects under
    // exactOptionalPropertyTypes. The schema already validated the shape.
    writeCuratorConfig(ctx.store, input as CuratorConfigPatch);
    return readCuratorConfig(ctx.store);
  }),

  // Observability: run history (most recent first) + per-run operations.
  runs: adminProcedure
    .input(ListRunsInputSchema.optional())
    .query(({ ctx, input }) => ctx.store.listCurationRuns((input ?? {}) as ListCurationRunsInput)),

  runOperations: adminProcedure
    .input(z.strictObject({ runId: z.string().min(1) }))
    .query(({ ctx, input }) => ctx.store.getCurationOperations(input.runId)),

  // Admin run-now: shares the scheduler enqueue path (manual trigger, bypasses the
  // input-hash skip). Synchronous — the admin awaits the result summary.
  runNow: adminProcedure.mutation(({ ctx }) =>
    runCuratorTick({ store: ctx.store, trigger: "manual", bypassSkip: true }),
  ),
});

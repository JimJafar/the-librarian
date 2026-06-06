// Intake (consolidator) admin tRPC procedures (spec 043 PR-5a / Task C5a).
//
// The parallel of the grooming `curatorRouter` (curator.ts), adapted for intake —
// so the unified curator dashboard (C5b) can render an Intake section with the
// same shape it already has for grooming: enablement + the per-consumer
// operational view (read-only here), run + per-operation observability over the
// C1 consolidation decision log, and an admin run-now.
//
// All admin-gated — there is deliberately NO consumer-agent surface for intake
// control. This router is read-only aggregation for the dashboard's Intake
// section; the provider/model WRITE surface is the existing `llm.setConsumerConfig`
// (not duplicated here). The one write `setConfig` owns is the intake enablement
// toggle (`curator.intake.enabled`).

import type {
  ConsolidatorTickResult,
  LibrarianStore,
  ListConsolidationRunsInput,
} from "@librarian/core";
import {
  isIntakeEnabled,
  readConsumerConfig,
  runConsolidatorTick,
  setIntakeEnabled,
} from "@librarian/core";
import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

// Mirror grooming's `runs` input (curator.ts ListRunsInputSchema), matching the
// C1 ListConsolidationRunsInput shape. All optional; the store clamps `limit`.
const ListRunsInputSchema = z.strictObject({
  status: z.string().optional(),
  trigger: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
});

// Intake's configured state in one read: the enablement flag (authoritative
// `curator.intake.enabled` setting) + the per-consumer operational view (provider/
// model/operational flags). The token is never part of this — `readConsumerConfig`
// returns presence-only `hasToken`, never the secret.
function readIntakeConfig(store: LibrarianStore) {
  return {
    enabled: isIntakeEnabled(store),
    consumer: readConsumerConfig(store, "intake"),
  };
}

// Run-now widens the tick result with a `disabled` skip — the enablement gate the
// router applies on top of the (enablement-agnostic) consolidator tick, mirroring
// grooming's CuratorTickSkipReason which already carries "disabled".
type RunNowResult = ConsolidatorTickResult | { ran: false; reason: "disabled" };

export const intakeRouter = router({
  // Intake's configured state (enablement + the read-only per-consumer view).
  config: adminProcedure.query(({ ctx }) => readIntakeConfig(ctx.store)),

  // Toggle intake enablement; returns the fresh readable config. The setting is
  // authoritative (spec 043 D-E) — toggling off actually disables the job.
  setConfig: adminProcedure
    .input(z.strictObject({ enabled: z.boolean() }))
    .mutation(({ ctx, input }) => {
      setIntakeEnabled(ctx.store, input.enabled);
      return readIntakeConfig(ctx.store);
    }),

  // Observability: consolidation run history (most recent first) + per-run ops,
  // over the C1 decision log (LibrarianStore extends ConsolidationStore).
  runs: adminProcedure
    .input(ListRunsInputSchema.optional())
    .query(({ ctx, input }) =>
      ctx.store.listConsolidationRuns((input ?? {}) as ListConsolidationRunsInput),
    ),

  runOperations: adminProcedure
    .input(z.strictObject({ runId: z.string().min(1) }))
    .query(({ ctx, input }) => ctx.store.getConsolidationOperations(input.runId)),

  // Admin run-now: force one inbox sweep. Mirrors grooming's run-now posture —
  // gated on enablement (the setting is authoritative), then runs the tick. Unlike
  // grooming there is no input-hash/debounce skip inside the intake sweep to bypass
  // (it always processes the whole inbox), so an enabled run-now is already a forced
  // sweep — it files queued items even though intake's scheduler never starts while
  // disabled. NB: an enabled intake sweep can also fire the C3 post-intake grooming
  // trigger (runConsolidatorTick's default), so an admin run-now may, like a
  // scheduled tick, arm a groom if the threshold/debounce allow — intentional and
  // consistent with the scheduled path.
  runNow: adminProcedure.mutation(({ ctx }): Promise<RunNowResult> | RunNowResult =>
    isIntakeEnabled(ctx.store)
      ? runConsolidatorTick({ store: ctx.store })
      : { ran: false, reason: "disabled" },
  ),
});

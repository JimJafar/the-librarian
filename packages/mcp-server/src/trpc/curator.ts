// Memory-curator admin tRPC procedures (memory-curator spec §7.1 / §13).
//
// The admin cockpit's typed surface: read/update the curator's NON-LLM config
// (enable flag, schedule, auto-apply posture), read-only run + operation
// observability, and the run-now control. All admin-gated — there is
// deliberately NO consumer-agent surface for curation (§12). The LLM connection
// is no longer part of this surface — named providers + per-consumer model
// selection live under the `llm` router (042 §4). The prompt addendum left this
// surface in spec 044 D-1 — it's a committed vault file now (its dashboard editor
// is D7); this router no longer reads or writes it.

import type { CuratorConfigPatch, EvidenceSlice, ListCurationRunsInput } from "@librarian/core";
import {
  CuratorConfigPatchSchema,
  dryRunGrooming,
  readCuratorConfig,
  runCuratorTick,
  writeCuratorConfig,
} from "@librarian/core";
import { z } from "zod";
import { logger } from "../logging.js";
import { adminProcedure, router } from "./trpc.js";

const ListRunsInputSchema = z.strictObject({
  status: z.string().optional(),
  trigger: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
});

// A slice key for the "dry-run this slice" path: the EvidenceSlice shape (kind +
// the one identifier that kind needs). projectKey is required for common_project,
// agentId for agent_private; common_global needs neither. Kept structural rather
// than a string key so the dashboard can build it from the slice it already shows.
const SliceKeySchema = z.strictObject({
  kind: z.enum(["common_project", "common_global", "agent_private"]),
  projectKey: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
});

// Input for curator.dryRunGrooming. The candidate is the UNCOMMITTED addendum text
// to preview; candidateLabel tags the throwaway batch; slice (optional) runs ONE
// slice synchronously (fast), else the whole corpus runs in the background.
const DryRunGroomingInputSchema = z.strictObject({
  candidateAddendum: z.string(),
  candidateLabel: z.string().min(1).optional(),
  slice: SliceKeySchema.optional(),
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

  // Grooming dry-run (spec 044 D-4): preview what a CANDIDATE (uncommitted) addendum
  // would do over the corpus, in propose-mode, WITHOUT committing the candidate live
  // and WITHOUT auto-applying anything. The candidate is threaded into the prompt
  // (redacted there) and NEVER written to the vault — the live addendum file/status/
  // version are untouched. Proposals are tagged dry-run (discardable). GROOMING ONLY
  // — intake input is consumed on apply (not replayable), so there is no intake dry-
  // run (the same reason intake has no re-evaluate). The dashboard buttons are D7.
  //
  // Two scopes:
  //  - slice given → run that ONE slice SYNCHRONOUSLY and return the result (the
  //    latency-sensitive "dry-run this slice" path the spec calls out as fast);
  //  - no slice → "dry-run everything" can be slow, so it must NOT block the request:
  //    run it as fire-and-forget background work and return a `{ started: true }` ack
  //    immediately. CAVEAT: there is NO progress handle — the admin polls the runs/
  //    proposals to see results. A failure in the background run is fail-soft (logged
  //    via the shared logger, never crashes the server).
  dryRunGrooming: adminProcedure
    .input(DryRunGroomingInputSchema)
    .mutation(async ({ ctx, input }) => {
      if (input.slice) {
        // Fast path: one slice, synchronous — the admin awaits the result.
        const slice: EvidenceSlice = {
          kind: input.slice.kind,
          ...(input.slice.projectKey !== undefined ? { projectKey: input.slice.projectKey } : {}),
          ...(input.slice.agentId !== undefined ? { agentId: input.slice.agentId } : {}),
        };
        return dryRunGrooming({
          store: ctx.store,
          candidateAddendum: input.candidateAddendum,
          ...(input.candidateLabel !== undefined ? { candidateLabel: input.candidateLabel } : {}),
          slice,
        });
      }
      // Whole-corpus path: fire-and-forget so the request returns fast. The run is
      // fail-soft inside `dryRunGrooming` (per-slice try/catch); we also guard the
      // promise so a top-level rejection (gating throw etc.) is logged, never unhandled.
      void dryRunGrooming({
        store: ctx.store,
        candidateAddendum: input.candidateAddendum,
        ...(input.candidateLabel !== undefined ? { candidateLabel: input.candidateLabel } : {}),
      }).catch((error: unknown) => {
        logger.error({ err: error }, "background grooming dry-run failed");
      });
      return { started: true };
    }),
});

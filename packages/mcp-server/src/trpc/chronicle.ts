import type { ChronicleConfigPatch, ListChronicleRunsInput } from "@librarian/core";
import {
  ChronicleConfigPatchSchema,
  readChronicleConfig,
  runChronicleTick,
  writeChronicleConfig,
} from "@librarian/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

const ListRunsInputSchema = z.strictObject({
  status: z.enum(["pending", "running", "completed", "failed"]).optional(),
  trigger: z.enum(["schedule", "manual"]).optional(),
  shelfId: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).optional(),
});

export const chronicleRouter = router({
  config: adminProcedure.query(({ ctx }) => readChronicleConfig(ctx.store)),

  setConfig: adminProcedure.input(ChronicleConfigPatchSchema).mutation(({ ctx, input }) => {
    try {
      return writeChronicleConfig(ctx.store, input as ChronicleConfigPatch);
    } catch (error) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });
    }
  }),

  runs: adminProcedure
    .input(ListRunsInputSchema.optional())
    .query(({ ctx, input }) =>
      ctx.store.listChronicleRuns((input ?? {}) as ListChronicleRunsInput),
    ),

  runNow: adminProcedure.mutation(({ ctx }) =>
    runChronicleTick({ store: ctx.store, trigger: "manual", allowDisabled: true }),
  ),
});

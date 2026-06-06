// LLM provider + per-consumer model config admin tRPC (spec 042 §4).
//
// The admin cockpit's typed surface for named LLM providers and the per-consumer
// (intake / grooming) provider+model selection. All admin-gated — there is no
// consumer-agent surface for LLM config. Provider tokens are write-only: reads
// expose presence only (`hasToken`), never the value; core's `addProvider` /
// `updateProvider` store the token encrypted.
//
// The model picker (`listModels`) + non-blocking "test connection" land with the
// dashboard UI in PR-B4b (they call out to the provider endpoint).

import type { ConsumerConfigPatch, LlmProviderInput, LlmProviderPatch } from "@librarian/core";
import {
  LlmProviderInputSchema,
  LlmProviderPatchSchema,
  addProvider,
  deleteProvider,
  getProvider,
  listProviders,
  readConsumerConfig,
  updateProvider,
  writeConsumerConfig,
} from "@librarian/core";
import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

const ConsumerSchema = z.enum(["intake", "grooming"]);

// Reuse core's patch schema (single source of truth) + the target id.
const UpdateProviderSchema = LlmProviderPatchSchema.extend({ id: z.string().min(1) });

const SetConsumerSchema = z.strictObject({
  consumer: ConsumerSchema,
  providerId: z.string().optional(),
  model: z.string().optional(),
  timeoutMs: z.number().optional(),
});

export const llmRouter = router({
  // Named providers — list/get never include the token, only `hasToken`.
  listProviders: adminProcedure.query(({ ctx }) => listProviders(ctx.store)),

  addProvider: adminProcedure
    .input(LlmProviderInputSchema)
    // Cast at the validated boundary: Zod `.optional()` infers `T | undefined`,
    // which the input type (optional-key, not undefined-value) rejects under
    // exactOptionalPropertyTypes. The schema already validated the shape.
    .mutation(({ ctx, input }) => addProvider(ctx.store, input as LlmProviderInput)),

  updateProvider: adminProcedure.input(UpdateProviderSchema).mutation(({ ctx, input }) => {
    const { id, ...patch } = input;
    updateProvider(ctx.store, id, patch as LlmProviderPatch);
    return getProvider(ctx.store, id);
  }),

  deleteProvider: adminProcedure
    .input(z.strictObject({ id: z.string().min(1) }))
    .mutation(({ ctx, input }) => {
      deleteProvider(ctx.store, input.id);
      return listProviders(ctx.store);
    }),

  // Per-consumer provider+model selection (intake / grooming).
  consumerConfig: adminProcedure
    .input(z.strictObject({ consumer: ConsumerSchema }))
    .query(({ ctx, input }) => readConsumerConfig(ctx.store, input.consumer)),

  setConsumerConfig: adminProcedure.input(SetConsumerSchema).mutation(({ ctx, input }) => {
    const { consumer, ...patch } = input;
    writeConsumerConfig(ctx.store, consumer, patch as ConsumerConfigPatch);
    return readConsumerConfig(ctx.store, consumer);
  }),
});

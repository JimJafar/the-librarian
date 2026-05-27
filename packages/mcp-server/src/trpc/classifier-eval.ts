// Classifier evaluation tRPC router (spec §4.6).
//
// `runEval` — builds a classifier from the operator-supplied config,
// runs the evaluation against the bundled seed fixture, appends a
// `classifier.evaluation_completed` event to the ledger, and returns
// the report. Admin-only.
//
// `softAlert` — reads the most recent `memory.classified` events and
// computes the §4.3 max-retries-rate alert. Returns zeros until
// Section 4d wires the worker into mcp-server startup; harmless to
// call earlier.

import { createClassifier, type Classifier, type ProviderConfig } from "@librarian/classifier";
import {
  computeSoftAlert,
  loadSeedFixture,
  runEval,
  type EvalReport,
} from "@librarian/classifier-eval";
import { createCuratorLlmClient, MemoryEventType, type LlmClientConfig } from "@librarian/core";
import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

const RunEvalInputSchema = z.strictObject({
  provider: z.literal("remote"),
  endpoint: z.string().url(),
  token: z.string().min(1),
  model: z.string().min(1),
  sample: z.number().int().positive().max(1000),
  category: z.enum(["all", "straight", "boundary"]),
  promptVersion: z.string().optional(),
});

const SoftAlertInputSchema = z
  .strictObject({
    window: z.number().int().positive().max(100).optional(),
    threshold: z.number().min(0).max(1).optional(),
  })
  .optional();

export const classifierEvalRouter = router({
  runEval: adminProcedure
    .input(RunEvalInputSchema)
    .mutation(async ({ ctx, input }): Promise<EvalReport> => {
      const classifier = buildRemoteClassifier(input);
      const fixture = loadSeedFixture();
      const report = await runEval(classifier, {
        fixture,
        sample: input.sample,
        category: input.category,
      });
      // Strip raw_output before persisting — model output can be large
      // and isn't needed for the timeline view; the dashboard already
      // got it in the return value if it needs to render the diff.
      ctx.store.appendEvent(
        MemoryEventType.ClassifierEvaluationCompleted,
        {
          run_id: report.run_id,
          provider: report.provider,
          model: report.model,
          prompt_version: report.prompt_version,
          sample_size: report.sample_size,
          filter: report.filter,
          agreement: report.agreement,
          fallback_counts: report.fallback_counts,
          latency_ms: report.latency_ms,
        },
        {},
      );
      return report;
    }),

  softAlert: adminProcedure.input(SoftAlertInputSchema).query(({ ctx, input }) => {
    const events = ctx.store.listEvents({ type: "memory.classified", limit: 100 });
    const classifications = events.events.map((event) => {
      const payload = (event.payload ?? {}) as { fallback_used?: string | false };
      return { fallback_used: payload.fallback_used };
    });
    return computeSoftAlert({
      classifications,
      ...(input?.window !== undefined ? { window: input.window } : {}),
      ...(input?.threshold !== undefined ? { threshold: input.threshold } : {}),
    });
  }),
});

interface RemoteClassifierInput {
  endpoint: string;
  token: string;
  model: string;
  promptVersion?: string | undefined;
}

function buildRemoteClassifier(input: RemoteClassifierInput): Classifier {
  const llmConfig: LlmClientConfig = {
    endpoint: input.endpoint,
    token: input.token,
    model: input.model,
  };
  const llm = createCuratorLlmClient(llmConfig);
  const providerConfig: ProviderConfig = { provider: "remote", modelId: input.model };
  if (input.promptVersion !== undefined) providerConfig.promptVersion = input.promptVersion;
  return createClassifier(providerConfig, { llm });
}

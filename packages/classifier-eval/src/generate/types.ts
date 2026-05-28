// Shared types for the `eval generate-fixture` pipeline (spec §4.7).
//
// `GraderConfig` describes a frontier-model endpoint that votes on
// each candidate. The spec calls for three graders from three model
// families (Claude / GPT / Gemini) so a single family's bias can't
// shape the resulting fixture. The pipeline enforces that all
// configured graders vote unanimously — anything less drops.

import { z } from "zod";

export const GraderConfigSchema = z.strictObject({
  /** Display name for logs + the `consensus_models` field on each fixture entry. */
  name: z.string().min(1),
  /** OpenAI-compatible base URL. */
  endpoint: z.string().url(),
  /** Model id passed in chat-completions requests. */
  model: z.string().min(1),
  /**
   * Environment variable name that holds the bearer token. The token
   * itself is never written to disk via this config — the CLI reads
   * `process.env[token_env]` at run time and refuses to start if any
   * referenced env var is unset.
   */
  token_env: z.string().min(1),
});
export type GraderConfig = z.infer<typeof GraderConfigSchema>;

export const PipelineConfigSchema = z.strictObject({
  /** The single strong LLM that generates candidate batches. */
  generator: GraderConfigSchema,
  /** Exactly 3 graders from distinct families (spec §4.7). */
  graders: z.array(GraderConfigSchema).length(3),
});
export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;

export interface PipelineTargets {
  /** Total fixture size (straight + boundary). Default 900 per spec. */
  total: number;
  /** Fraction of `total` that should be boundary cases. Default 0.4. */
  boundaryRatio: number;
}

export interface PipelineBudget {
  /**
   * Hard cap on total LLM calls (generator batches + grader votes).
   * Defaults to a generous 8000 for the spec's ~5500 expected calls.
   */
  maxCalls: number;
}

export interface PipelineOptions {
  config: PipelineConfig;
  targets: PipelineTargets;
  budget: PipelineBudget;
  /** Candidates to generate per generator call. Default 100. */
  candidatesPerBatch: number;
  /** Max generator batches before giving up. Default 12. */
  maxIterations: number;
  /** Optional progress sink. */
  log?: (entry: PipelineLogEvent) => void;
}

export type PipelineLogEvent =
  | { event: "iteration"; iteration: number; haveStraight: number; haveBoundary: number }
  | { event: "batch_generated"; iteration: number; candidates: number; callCount: number }
  | { event: "candidate_dropped"; reason: string; callCount: number }
  | {
      event: "candidate_kept";
      verdict: { requires_approval: boolean; is_global: boolean };
      callCount: number;
    }
  | { event: "done"; iterations: number; calls: number };

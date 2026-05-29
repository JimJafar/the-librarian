// Classifier types — input to classify(), the verdict, and the
// fallback taxonomy. See docs/specs/done/023-classifier-implementation-spec.md
// §4.1 (state machine), §4.5 (output schema), §4.8 (event shape).

import { z } from "zod";

/** Minimal memory shape the classifier needs. Title + body + tags. */
export interface ClassifyInput {
  title: string;
  body: string;
  tags: readonly string[];
}

/**
 * The two booleans the classifier decides for every memory.
 *
 * - `requires_approval` — true when the memory contains identity /
 *   relationship facts or anything an owner would want to review
 *   before it becomes active.
 * - `is_global` — true when the memory should bypass per-conversation
 *   domain filtering and be available everywhere.
 */
export const ClassifierVerdictSchema = z
  .strictObject({
    requires_approval: z.boolean(),
    is_global: z.boolean(),
  })
  .strict();

export type ClassifierVerdict = z.infer<typeof ClassifierVerdictSchema>;

/**
 * Why a verdict was conservative-default rather than model-driven.
 * Recorded on the `memory.classified` event so the eval harness can
 * exclude these from agreement scoring (§4.8).
 */
export type ClassifierFallbackReason =
  | "parse" // Model output couldn't be parsed against the schema.
  | "provider_unavailable" // Provider returned a non-2xx status or refused.
  | "timeout" // Per-attempt timeout elapsed.
  | "max_retries"; // Worker gave up after 3 failed attempts.

/**
 * The full result of one classify() call. `verdict` is always present
 * (conservative defaults applied on every failure path); `fallback_used`
 * is set only when those defaults were imposed by the classifier rather
 * than chosen by the model.
 *
 * `raw_output` is the model's literal text — preserved verbatim so the
 * eval harness (Section 4c) can replay parse failures and score prompt
 * regressions. It's the empty string when fallback fired before any
 * model output was produced (network error, timeout).
 */
export interface ClassifyResult {
  verdict: ClassifierVerdict;
  /** Set when the verdict came from a fallback path rather than the model. */
  fallback_used?: ClassifierFallbackReason;
  /** Prompt version that produced the verdict (e.g. `"v1"`). */
  prompt_version: string;
  /** Provider that was asked. `"none"` when fallback fired before dispatch. */
  provider: "remote" | "none";
  /** Model id reported by the provider (or the configured id when not). */
  model: string;
  /** End-to-end wall-clock latency in ms. */
  latency_ms: number;
  /**
   * The raw text returned by the model (`""` when no model output was
   * produced — network error, timeout). Captured so the eval harness
   * can diff parse failures and prompt regressions.
   */
  raw_output: string;
}

/**
 * The conservative-default verdict applied on every fallback path.
 * Owner-safe (nothing leaks globally; everything routes through the
 * proposal queue). See spec §4.1's "conservative defaults" definition.
 */
export const CONSERVATIVE_DEFAULTS: Readonly<ClassifierVerdict> = Object.freeze({
  requires_approval: true,
  is_global: false,
});

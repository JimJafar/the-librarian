// Custom-model self-test — runs the v1 prompt against a known input
// and confirms the parser returns a verdict. Used by the dashboard's
// "save custom model" path (spec §4.3) so a misconfigured model
// surfaces immediately rather than silently degrading the classifier.

import type { Classifier } from "./providers/index.js";

/**
 * The canonical self-test memory. Identity-flavoured — any working
 * classifier should return at least parseable JSON against it. We
 * don't check verdict content; that's the dashboard eval's job. This
 * gate is "does the model produce structured output at all."
 */
export const SELF_TEST_INPUT = Object.freeze({
  title: "Operator's preferred name",
  body: "The operator goes by Jim in conversation.",
  tags: ["identity"] as readonly string[],
});

/**
 * Tighter than the classifier's 30s per-attempt timeout — the dashboard
 * save flow is interactive, so a hang here should fail visibly within
 * ten seconds rather than pause the UI for half a minute.
 */
export const SELF_TEST_TIMEOUT_MS = 10_000;

export interface SelfTestResult {
  ok: boolean;
  /** Raw model output — surfaced in the dashboard error message on failure. */
  raw_output: string;
  /** Latency of the test call, in ms. */
  latency_ms: number;
  /** When `ok === false`, the fallback flag that fired (`"parse"`, `"timeout"`, ...). */
  reason?: string;
}

/**
 * Run the self-test against the classifier. Returns `ok: true` when
 * the model produced parseable JSON; `ok: false` with the raw output
 * and fallback reason otherwise. Never throws.
 */
export async function runSelfTest(classifier: Classifier): Promise<SelfTestResult> {
  const result = await classifier.classify(SELF_TEST_INPUT, { timeoutMs: SELF_TEST_TIMEOUT_MS });
  if (result.fallback_used === undefined) {
    return { ok: true, raw_output: result.raw_output, latency_ms: result.latency_ms };
  }
  return {
    ok: false,
    raw_output: result.raw_output,
    latency_ms: result.latency_ms,
    reason: result.fallback_used,
  };
}

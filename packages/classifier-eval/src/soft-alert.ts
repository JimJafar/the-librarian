// Soft-alert helper — computes the `max_retries` rate over a recent
// window of `memory.classified` events. Per spec §4.3:
//
//   "The dashboard surfaces a warning when more than 20% of
//    classifications in the last 100 hit `fallback_used: 'max_retries'`."
//
// The helper is a pure function; the dashboard calls it with the
// events array and renders a banner when `exceedsThreshold` is true.

export interface SoftAlertInput {
  /**
   * Recent classifications, ordered from newest to oldest (or any
   * order — only the last `window` items by appearance matter).
   */
  classifications: ReadonlyArray<{ fallback_used: string | false | undefined }>;
  /** Window size. Defaults to 100 per spec §4.3. */
  window?: number;
  /** Threshold rate in [0, 1]. Defaults to 0.2 per spec §4.3. */
  threshold?: number;
}

export interface SoftAlertResult {
  /** Number of `max_retries` fallbacks in the window. */
  maxRetriesCount: number;
  /** Total observations in the window. */
  windowSize: number;
  /** Rate of `max_retries` in `[0, 1]`. */
  rate: number;
  /** True when `rate > threshold` (strict — spec §4.3 says "more than 20%"). */
  exceedsThreshold: boolean;
}

export const DEFAULT_SOFT_ALERT_WINDOW = 100;
export const DEFAULT_SOFT_ALERT_THRESHOLD = 0.2;

export function computeSoftAlert(input: SoftAlertInput): SoftAlertResult {
  const window = input.window ?? DEFAULT_SOFT_ALERT_WINDOW;
  const threshold = input.threshold ?? DEFAULT_SOFT_ALERT_THRESHOLD;
  const slice = input.classifications.slice(0, window);
  const windowSize = slice.length;
  if (windowSize === 0) {
    return { maxRetriesCount: 0, windowSize: 0, rate: 0, exceedsThreshold: false };
  }
  let maxRetriesCount = 0;
  for (const c of slice) {
    if (c.fallback_used === "max_retries") maxRetriesCount++;
  }
  const rate = maxRetriesCount / windowSize;
  return {
    maxRetriesCount,
    windowSize,
    rate,
    exceedsThreshold: rate > threshold,
  };
}

// Soft-alert banner — shown when the recent classification window
// exceeds the §4.3 max-retries threshold.

export interface SoftAlertProps {
  maxRetriesCount: number;
  windowSize: number;
  rate: number;
  exceedsThreshold: boolean;
}

export function ClassifierEvalSoftAlert({ alert }: { alert: SoftAlertProps }) {
  if (!alert.exceedsThreshold) return null;
  return (
    <div className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
      <strong className="font-semibold text-amber-900 dark:text-amber-200">
        Elevated max-retries rate
      </strong>
      <p className="mt-1 text-amber-900/90 dark:text-amber-200/90">
        {alert.maxRetriesCount} of the last {alert.windowSize} classifications hit{" "}
        <code>fallback_used: &quot;max_retries&quot;</code> ({(alert.rate * 100).toFixed(0)}%).
        That&apos;s a strong signal the configured model is producing malformed output. Run the
        evaluation against a candidate model from this page before promoting it, or check the
        classifier admin config.
      </p>
    </div>
  );
}

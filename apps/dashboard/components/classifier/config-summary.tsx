// Read-only summary of the classifier config (spec:
// classifier-dashboard-config). The token is never shown — only
// whether one is configured (config.hasToken). Drift banner is
// rendered when the running worker's config diverges from the stored
// config; the restart button itself lives in restart-worker-button.tsx.

import type { ClassifierConfig } from "@librarian/core";

function statusOf(config: ClassifierConfig): { label: string; tone: string } {
  if (config.isOperational) return { label: "Operational", tone: "text-green-600" };
  if (config.enabled) return { label: "Enabled — config incomplete", tone: "text-amber-600" };
  return { label: "Disabled", tone: "text-muted-foreground" };
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-sm">{value}</span>
    </div>
  );
}

export function ClassifierConfigSummary({
  config,
  hasDrift,
}: {
  config: ClassifierConfig;
  hasDrift: boolean;
}) {
  const status = statusOf(config);
  return (
    <section className="rounded-md border bg-card p-4" aria-label="Classifier configuration">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="font-semibold">Configuration</h2>
        <span className={`text-sm font-medium ${status.tone}`}>{status.label}</span>
      </header>
      {hasDrift ? (
        <div
          role="status"
          aria-live="polite"
          className="mb-3 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-sm text-amber-900 dark:text-amber-100"
        >
          Config has changed since the worker started. Restart to apply.
        </div>
      ) : null}
      <Row label="Provider" value={config.llm.provider || "—"} />
      <Row label="Endpoint" value={config.llm.endpoint || "—"} />
      <Row label="Model" value={config.llm.model || "—"} />
      <Row label="Timeout (ms)" value={String(config.llm.timeoutMs)} />
      <Row label="API token" value={config.hasToken ? "configured" : "not set"} />
      <Row label="Prompt version" value={config.promptVersion ?? "(default)"} />
    </section>
  );
}

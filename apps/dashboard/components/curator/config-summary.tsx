// Read-only summary of the memory-curator's NON-LLM config (spec §7.1 / §13). The
// LLM connection lives in the provider manager + per-consumer selectors below it.

import type { CuratorConfig } from "@librarian/core";

function statusOf(config: CuratorConfig): { label: string; tone: string } {
  return config.enabled
    ? { label: "Enabled", tone: "text-green-600" }
    : { label: "Disabled", tone: "text-muted-foreground" };
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-sm">{value}</span>
    </div>
  );
}

export function CuratorConfigSummary({ config }: { config: CuratorConfig }) {
  const status = statusOf(config);
  return (
    <section className="rounded-md border bg-card p-4" aria-label="Curator configuration">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="font-semibold">Configuration</h2>
        <span className={`text-sm font-medium ${status.tone}`}>{status.label}</span>
      </header>
      <Row label="Schedule" value={`every ${config.intervalMinutes} minute(s)`} />
      <Row label="Auto-apply" value={config.defaultAutoApply} />
      <Row label="Confidence threshold" value={String(config.autoApplyConfidence)} />
    </section>
  );
}

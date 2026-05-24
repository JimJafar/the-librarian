// Read-only summary of the memory-curator config (spec §7.1 / §13). The token is
// never shown — only whether one is configured (config.hasToken).

import type { CuratorConfig } from "@librarian/core";

function statusOf(config: CuratorConfig): { label: string; tone: string } {
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

export function CuratorConfigSummary({ config }: { config: CuratorConfig }) {
  const status = statusOf(config);
  return (
    <section className="rounded-md border bg-card p-4" aria-label="Curator configuration">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="font-semibold">Configuration</h2>
        <span className={`text-sm font-medium ${status.tone}`}>{status.label}</span>
      </header>
      <Row
        label="Schedule"
        value={`every ${config.schedule.intervalDays}d at ${config.schedule.time}`}
      />
      <Row label="Provider" value={config.llm.provider || "—"} />
      <Row label="Endpoint" value={config.llm.endpoint || "—"} />
      <Row label="Model" value={config.llm.model || "—"} />
      <Row label="API token" value={config.hasToken ? "configured" : "not set"} />
      <Row label="Auto-apply" value={config.defaultAutoApply} />
      <Row label="Confidence threshold" value={String(config.autoApplyConfidence)} />
      <Row label="Prompt addendum" value={config.promptAddendum ? "set" : "—"} />
    </section>
  );
}

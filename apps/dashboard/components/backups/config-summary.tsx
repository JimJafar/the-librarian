// Read-only summary of the backup config (automated-backups A6). No secret values
// are shown — only whether the token is set.

export interface BackupCockpitConfig {
  enabled: boolean;
  intervalMinutes: number;
  webhookUrl: string;
  github: { repo: string; hasToken: boolean };
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-sm">{value}</span>
    </div>
  );
}

export function BackupConfigSummary({ config }: { config: BackupCockpitConfig }) {
  return (
    <section className="rounded-md border bg-card p-4" aria-label="Backup configuration">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="font-semibold">Configuration</h2>
        <span
          className={`text-sm font-medium ${config.enabled ? "text-green-600" : "text-muted-foreground"}`}
        >
          {config.enabled ? "Schedule enabled" : "Schedule disabled"}
        </span>
      </header>
      <Row
        label="Remote"
        value={config.github.repo ? `GitHub → ${config.github.repo}` : "(no remote configured)"}
      />
      <Row label="Token" value={config.github.hasToken ? "set" : "not set"} />
      <Row label="Frequency" value={`every ${config.intervalMinutes} minute(s)`} />
      <Row label="Failure webhook" value={config.webhookUrl ? "configured" : "off"} />
    </section>
  );
}

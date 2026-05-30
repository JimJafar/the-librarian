// Read-only summary of the backup config (automated-backups A6). No secret values
// are shown — only whether each credential is set.

export interface BackupCockpitConfig {
  enabled: boolean;
  intervalMinutes: number;
  target: "local" | "s3" | "github";
  retentionKeep: number;
  webhookUrl: string;
  s3: {
    bucket: string;
    region: string;
    endpoint: string;
    prefix: string;
    hasAccessKey: boolean;
    hasSecretKey: boolean;
  };
  github: { repo: string; hasToken: boolean };
}

function targetLabel(config: BackupCockpitConfig): string {
  if (config.target === "s3") return `S3 → ${config.s3.bucket || "(no bucket)"}`;
  if (config.target === "github") return `GitHub → ${config.github.repo || "(no repo)"}`;
  return "local only";
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
      <Row label="Cloud target" value={targetLabel(config)} />
      <Row label="Frequency" value={`every ${config.intervalMinutes} minute(s)`} />
      <Row label="Retention" value={`keep ${config.retentionKeep} bundle(s)`} />
      <Row label="Failure webhook" value={config.webhookUrl ? "configured" : "off"} />
    </section>
  );
}

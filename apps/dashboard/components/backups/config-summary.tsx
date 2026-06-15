// Backup-config type, lifted out for cross-component imports. The live
// summary (Configured / Disabled / Last successful) used to live here too
// — the Phase 4 polish folds it into the page-level Status strip + the
// config form's own field state (which IS the summary, no duplication).

export interface BackupCockpitConfig {
  enabled: boolean;
  intervalMinutes: number;
  webhookUrl: string;
  github: { repo: string; hasToken: boolean };
}

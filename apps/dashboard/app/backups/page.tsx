// Backups cockpit (automated-backups A6) — health banner, config (target + schedule
// + retention + webhook), recent bundles with one-click restore, and run history.

import {
  backupNowAction,
  restartAction,
  saveBackupConfigAction,
  stageRestoreAction,
} from "./actions";
import { BackupNowButton } from "@/components/backups/backup-now-button";
import { BackupConfigForm } from "@/components/backups/config-form";
import { type BackupCockpitConfig, BackupConfigSummary } from "@/components/backups/config-summary";
import { RestoreButton } from "@/components/backups/restore-button";
import { BackupRunsTable } from "@/components/backups/runs-table";
import { serverTRPC } from "@/lib/trpc-server";

export const dynamic = "force-dynamic";

function HealthBanner({
  config,
}: {
  config: Awaited<ReturnType<typeof serverTRPC.backup.config.query>>;
}) {
  if (config.lastRun?.status === "error") {
    return (
      <p
        role="alert"
        className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm"
      >
        ⚠️ Last backup failed: {config.lastRun.error ?? "unknown error"}
      </p>
    );
  }
  if (config.lastSuccess) {
    return (
      <p className="rounded-md border border-green-600/40 bg-green-50 p-3 text-sm dark:bg-green-950/20">
        ✓ Last successful backup {new Date(config.lastSuccess.created_at).toLocaleString()}
        {config.lastSuccess.synced ? " (synced to cloud)" : ""}.
      </p>
    );
  }
  return <p className="text-sm text-muted-foreground">No backups yet.</p>;
}

export default async function BackupsPage() {
  let backups: Awaited<ReturnType<typeof serverTRPC.backup.list.query>> = [];
  let runs: Awaited<ReturnType<typeof serverTRPC.backup.runs.query>> = [];
  let config: Awaited<ReturnType<typeof serverTRPC.backup.config.query>> | null = null;
  let error: string | null = null;
  try {
    [backups, runs, config] = await Promise.all([
      serverTRPC.backup.list.query(),
      serverTRPC.backup.runs.query({ limit: 10 }),
      serverTRPC.backup.config.query(),
    ]);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return (
    <main className="flex flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Backups</h1>
        <BackupNowButton onRun={backupNowAction} />
      </header>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {config ? <HealthBanner config={config} /> : null}
      {config ? <BackupConfigSummary config={config as BackupCockpitConfig} /> : null}
      {config ? (
        <BackupConfigForm initial={config as BackupCockpitConfig} onSave={saveBackupConfigAction} />
      ) : null}

      <section className="rounded-md border bg-card p-4" aria-label="Recent backups">
        <h2 className="mb-3 font-semibold">Recent backups</h2>
        {backups.length === 0 ? (
          <p className="text-sm text-muted-foreground">No backups yet.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {backups.map((b) => (
              <li key={b.name} className="flex flex-wrap items-center justify-between gap-3">
                <span className="font-mono">{b.name}</span>
                <span className="text-muted-foreground">
                  {new Date(b.created_at).toLocaleString()}
                </span>
                <RestoreButton
                  bundle={b.name}
                  onStage={stageRestoreAction}
                  onRestart={restartAction}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-md border bg-card p-4" aria-label="Run history">
        <h2 className="mb-3 font-semibold">Run history</h2>
        <BackupRunsTable runs={runs} />
      </section>
    </main>
  );
}

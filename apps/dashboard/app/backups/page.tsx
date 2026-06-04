// Backups cockpit (automated-backups A6) — health banner, config (the GitHub
// remote + schedule + webhook), and run history. A backup is a `git push` of the
// memory vault to the configured GitHub repo; restore is `git clone` (runbook).

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
        {config.lastSuccess.target ? ` → ${config.lastSuccess.target}` : ""}.
      </p>
    );
  }
  return <p className="text-sm text-muted-foreground">No backups yet.</p>;
}

export default async function BackupsPage() {
  let runs: Awaited<ReturnType<typeof serverTRPC.backup.runs.query>> = [];
  let config: Awaited<ReturnType<typeof serverTRPC.backup.config.query>> | null = null;
  let error: string | null = null;
  try {
    [runs, config] = await Promise.all([
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

      <section className="rounded-md border bg-card p-4" aria-label="Restore">
        <h2 className="mb-1 font-semibold">Restore</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Clone the latest backup from the configured repo and swap it in on the next restart. Your
          current vault is preserved as <code>vault.pre-restore.bak</code>.
        </p>
        <RestoreButton onStage={stageRestoreAction} onRestart={restartAction} />
      </section>

      <section className="rounded-md border bg-card p-4" aria-label="Run history">
        <h2 className="mb-3 font-semibold">Run history</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Each backup pushes the memory vault to your GitHub repo.
        </p>
        <BackupRunsTable runs={runs} />
      </section>
    </main>
  );
}

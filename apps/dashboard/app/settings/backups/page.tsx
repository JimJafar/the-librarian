// Backups cockpit (automated-backups A6) — Phase 4 editorial rebuild.
// A flat page: Status strip → Configuration form → Restore → Recent
// backups. A backup is a `git push` of the memory vault to the
// configured GitHub repo; restore is `git clone` (runbook).

import {
  backupNowAction,
  restartAction,
  saveBackupConfigAction,
  stageRestoreAction,
} from "./actions";
import { BackupNowButton } from "@/components/backups/backup-now-button";
import { BackupConfigForm } from "@/components/backups/config-form";
import type { BackupCockpitConfig } from "@/components/backups/config-summary";
import { RestoreButton } from "@/components/backups/restore-button";
import { BackupRunsTable } from "@/components/backups/runs-table";
import { Hairline } from "@/components/ui-v2/hairline";
import { SectionLabel } from "@/components/ui-v2/section-label";
import { serverTRPC } from "@/lib/trpc-server";

export const dynamic = "force-dynamic";

type CockpitConfig = Awaited<ReturnType<typeof serverTRPC.backup.config.query>>;

function HealthStrip({ config }: { config: CockpitConfig }) {
  if (config.lastRun?.status === "error") {
    return (
      <div
        role="alert"
        aria-label="Backup health"
        className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
      >
        <strong>Last backup failed:</strong> {config.lastRun.error ?? "unknown error"}
      </div>
    );
  }
  if (config.lastSuccess) {
    const stamp = new Date(config.lastSuccess.created_at).toLocaleString();
    return (
      <div
        role="status"
        aria-label="Backup health"
        className="flex flex-wrap items-center gap-2.5 border-y border-ink-hairline bg-ink-surface px-4 py-3"
      >
        <span
          aria-hidden
          className="size-2 rounded-full bg-ink-accent [box-shadow:0_0_0_3px_color-mix(in_oklch,var(--ink-accent)_18%,transparent)]"
        />
        <span className="text-sm text-foreground">
          Last successful backup {stamp}
          {config.lastSuccess.target ? ` → ${config.lastSuccess.target}` : ""}.
        </span>
      </div>
    );
  }
  return (
    <div
      role="status"
      aria-label="Backup health"
      className="flex flex-wrap items-center gap-2.5 border-y border-ink-hairline bg-ink-surface px-4 py-3"
    >
      <span
        aria-hidden
        className="size-2 rounded-full border border-foreground/30 bg-transparent"
      />
      <span className="text-sm text-foreground/70">No backups yet.</span>
    </div>
  );
}

export default async function BackupsPage() {
  let runs: Awaited<ReturnType<typeof serverTRPC.backup.runs.query>> = [];
  let config: CockpitConfig | null = null;
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
    <main className="flex flex-col gap-8 p-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-xl text-foreground">Backups</h1>
        <p className="text-sm text-foreground/60">
          A backup <code className="font-mono text-foreground/80">git push</code>es the memory vault
          to your GitHub repo. Restore clones the latest backup and swaps it in on the next restart;
          your current vault is preserved as{" "}
          <code className="font-mono text-foreground/80">vault.pre-restore.bak</code>.
        </p>
      </header>

      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      {config ? <HealthStrip config={config} /> : null}

      {config ? (
        <section className="flex flex-col gap-3" aria-label="Backup configuration">
          <SectionLabel as="h2">Configuration</SectionLabel>
          <BackupConfigForm
            initial={config as BackupCockpitConfig}
            onSave={saveBackupConfigAction}
          />
        </section>
      ) : null}

      <Hairline />

      <section className="flex flex-col gap-3" aria-label="Restore">
        <SectionLabel as="h2">Restore</SectionLabel>
        <p className="max-w-prose text-sm text-foreground/60">
          Clone the latest backup and swap it in on the next restart. Your current vault is
          preserved as <code className="font-mono text-foreground/80">vault.pre-restore.bak</code> —
          destructive only if you don't roll it back.
        </p>
        <RestoreButton onStage={stageRestoreAction} onRestart={restartAction} />
      </section>

      <Hairline />

      <section className="flex flex-col gap-3" aria-label="Run history">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <SectionLabel as="h2">Recent backups</SectionLabel>
          <BackupNowButton onRun={backupNowAction} />
        </header>
        <BackupRunsTable runs={runs} />
      </section>
    </main>
  );
}

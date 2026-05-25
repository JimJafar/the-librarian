// Backups cockpit — recent backups + a "Backup now" trigger + cloud-sync status.
// The backend (tRPC backup router) handles the actual snapshot + optional upload.

import { backupNowAction } from "./actions";
import { BackupNowButton } from "@/components/backups/backup-now-button";
import { serverTRPC } from "@/lib/trpc-server";

export const dynamic = "force-dynamic";

export default async function BackupsPage() {
  let backups: Awaited<ReturnType<typeof serverTRPC.backup.list.query>> = [];
  let config: Awaited<ReturnType<typeof serverTRPC.backup.config.query>> | null = null;
  let error: string | null = null;
  try {
    [backups, config] = await Promise.all([
      serverTRPC.backup.list.query(),
      serverTRPC.backup.config.query(),
    ]);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const syncOn = Boolean(config?.bucket && config.hasAccessKey && config.hasSecretKey);

  return (
    <main className="flex flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Backups</h1>
        <BackupNowButton onRun={backupNowAction} />
      </header>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <p className="text-sm text-muted-foreground">
        Cloud sync: {syncOn ? `enabled → ${config?.bucket}` : "not configured"}.
      </p>
      <section className="rounded-md border bg-card p-4" aria-label="Recent backups">
        <h2 className="mb-3 font-semibold">Recent backups</h2>
        {backups.length === 0 ? (
          <p className="text-sm text-muted-foreground">No backups yet.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {backups.map((b) => (
              <li key={b.name} className="flex justify-between gap-4">
                <span className="font-mono">{b.name}</span>
                <span className="text-muted-foreground">{b.created_at}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

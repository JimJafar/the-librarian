"use client";

import { useState, useTransition } from "react";
import type { RestartResult } from "@/app/backups/actions";

export function RestartPrompt({
  onRestart,
  stagedFrom,
}: {
  onRestart: () => Promise<RestartResult>;
  stagedFrom?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const restart = () =>
    startTransition(async () => {
      const res = await onRestart();
      if (!res.ok) setError(res.error);
    });

  return (
    <div className="flex flex-col gap-2 rounded-md border border-amber-500/50 bg-amber-50 p-3 text-sm dark:bg-amber-950/20">
      <p>
        ✓ Restore staged{stagedFrom ? ` from ${stagedFrom}` : ""}.{" "}
        <strong>Restart required to apply</strong> — the backup is swapped in on the next boot, and
        your current vault is kept as <code>vault.pre-restore.bak</code>.
      </p>
      <p className="text-muted-foreground">
        Heads up: this only recovers if the server runs under an auto-restart supervisor — otherwise
        it will <strong>not come back</strong> on its own.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={restart}
          className="rounded-md border bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground disabled:opacity-50"
        >
          {pending ? "Restarting…" : "Restart now"}
        </button>
        {error ? <span className="text-sm text-destructive">Error: {error}</span> : null}
      </div>
    </div>
  );
}

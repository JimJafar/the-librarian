"use client";

import { useState, useTransition } from "react";
import type { RestartResult } from "@/app/settings/backups/actions";
import { Button } from "@/components/ui-v2/button";

// Editorial restart-required callout. Copper hairline + tint for the
// "important but not destructive" tier — staging a restore IS reversible
// (the current vault is preserved as vault.pre-restore.bak); restart is
// the destructive moment, so its action wears the destructive variant.

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
    <div className="flex flex-col gap-3 border border-ink-copper/40 bg-ink-copper/[0.06] p-4 text-sm text-foreground">
      <p>
        Restore staged{stagedFrom ? ` from ${stagedFrom}` : ""}.{" "}
        <strong>Restart required to apply</strong> — the backup is swapped in on the next boot, and
        your current vault is kept as{" "}
        <code className="font-mono text-foreground/80">vault.pre-restore.bak</code>.
      </p>
      <p className="text-foreground/70">
        Heads up: this only recovers if the server runs under an auto-restart supervisor — otherwise
        it will <strong>not come back</strong> on its own.
      </p>
      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-2 text-sm text-destructive"
        >
          Error: {error}
        </p>
      ) : null}
      <div>
        <Button type="button" variant="destructive" disabled={pending} onClick={restart}>
          {pending ? "Restarting…" : "Restart now"}
        </Button>
      </div>
    </div>
  );
}

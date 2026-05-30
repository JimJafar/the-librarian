"use client";

import { useState, useTransition } from "react";
import type { RestartResult } from "@/app/backups/actions";

// Shown after a restore is staged: a restart applies it on the next boot. The
// warning is load-bearing (Decision 10) — a bare process won't come back.
export function RestartPrompt({ onRestart }: { onRestart: () => Promise<RestartResult> }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const restart = () =>
    startTransition(async () => {
      const res = await onRestart();
      setMessage(res.ok ? "Restarting… reconnect in a moment." : `Error: ${res.error}`);
    });

  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-md border border-amber-500/50 bg-amber-50 p-3 text-sm dark:bg-amber-950/30"
    >
      <p className="font-medium">Restart required to apply this restore.</p>
      <p className="text-xs text-muted-foreground">
        Only use “Restart now” if The Librarian runs under an auto-restart supervisor (Docker{" "}
        <code>restart:</code> policy, systemd <code>Restart=</code>, Fly, …). On a bare process it
        will shut down and <strong>not come back</strong> — restart it yourself instead.
      </p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={restart}
          disabled={pending}
          className="rounded-md border bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground disabled:opacity-50"
        >
          {pending ? "Restarting…" : "Restart now"}
        </button>
        {message ? <span className="text-sm text-muted-foreground">{message}</span> : null}
      </div>
    </div>
  );
}

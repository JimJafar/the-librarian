"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { BackupNowResult } from "@/app/settings/backups/actions";
import { Button } from "@/components/ui-v2/button";

// "Backup now" — outline button with an auto-clearing inline status. Mirrors
// the curator Run-now pattern: errors get the red-ochre alert callout
// instead of sharing the foreground/70 success channel.

export function BackupNowButton({ onRun }: { onRun: () => Promise<BackupNowResult> }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [errored, setErrored] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (!message) return;
    const id = window.setTimeout(() => {
      setMessage(null);
      setErrored(false);
    }, 5000);
    return () => window.clearTimeout(id);
  }, [message]);

  const run = () =>
    startTransition(async () => {
      const res = await onRun();
      if (res.ok) {
        setMessage(`Pushed to ${res.repo}${res.commit ? ` (${res.commit.slice(0, 7)})` : ""}.`);
        setErrored(false);
        router.refresh();
      } else {
        setMessage(res.error);
        setErrored(true);
      }
    });

  return (
    <div className="flex flex-wrap items-center justify-end gap-3">
      {message ? (
        <p
          role={errored ? "alert" : "status"}
          className={
            errored
              ? "border border-destructive/40 bg-destructive/[0.06] px-3 py-1.5 text-sm text-destructive"
              : "text-sm text-foreground/70"
          }
        >
          {errored ? `Error: ${message}` : message}
        </p>
      ) : null}
      <Button type="button" variant="outline" onClick={run} disabled={pending}>
        {pending ? "Backing up…" : "Backup now"}
      </Button>
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { BackupNowResult } from "@/app/backups/actions";

export function BackupNowButton({ onRun }: { onRun: () => Promise<BackupNowResult> }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const router = useRouter();

  const run = () =>
    startTransition(async () => {
      const res = await onRun();
      if (res.ok) {
        setMessage(`Pushed to ${res.repo}${res.commit ? ` (${res.commit.slice(0, 7)})` : ""}.`);
        router.refresh();
      } else {
        setMessage(`Error: ${res.error}`);
      }
    });

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className="rounded-md border bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {pending ? "Backing up…" : "Backup now"}
      </button>
      {message ? <span className="text-sm text-muted-foreground">{message}</span> : null}
    </div>
  );
}

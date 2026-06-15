"use client";

import { useState, useTransition } from "react";
import { RestartPrompt } from "./restart-prompt";
import type { RestartResult, StageRestoreResult } from "@/app/settings/backups/actions";

export function RestoreButton({
  onStage,
  onRestart,
}: {
  onStage: () => Promise<StageRestoreResult>;
  onRestart: () => Promise<RestartResult>;
}) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [staged, setStaged] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stage = () =>
    startTransition(async () => {
      const res = await onStage();
      if (res.ok) {
        setStaged(res.staged);
        setConfirming(false);
      } else {
        setError(res.error);
      }
    });

  // Once staged, the only next step is the restart that applies it.
  if (staged) return <RestartPrompt onRestart={onRestart} stagedFrom={staged} />;

  return (
    <div className="flex flex-col gap-2">
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-destructive">
            This clones the latest backup and replaces your current vault on the next restart.
            Continue?
          </span>
          <button
            type="button"
            disabled={pending}
            onClick={stage}
            className="rounded-md border bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground disabled:opacity-50"
          >
            {pending ? "Cloning…" : "Confirm restore"}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="rounded-md border px-3 py-1.5 text-sm font-medium"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="self-start rounded-md border px-3 py-1.5 text-sm font-medium"
        >
          Restore from backup…
        </button>
      )}
      {error ? <span className="text-sm text-destructive">Error: {error}</span> : null}
    </div>
  );
}

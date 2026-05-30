"use client";

import { useState, useTransition } from "react";
import { RestartPrompt } from "./restart-prompt";
import type { RestartResult, StageRestoreResult } from "@/app/backups/actions";

// Per-bundle restore. Restoring is destructive (it replaces current data on the
// next restart), so it's two-step: Restore → Confirm. On a successful stage it
// reveals the warned restart prompt.
export function RestoreButton({
  bundle,
  onStage,
  onRestart,
}: {
  bundle: string;
  onStage: (bundle: string) => Promise<StageRestoreResult>;
  onRestart: () => Promise<RestartResult>;
}) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [staged, setStaged] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stage = () =>
    startTransition(async () => {
      const res = await onStage(bundle);
      if (res.ok) {
        setStaged(true);
        setConfirming(false);
      } else {
        setError(res.error);
        setConfirming(false);
      }
    });

  if (staged) return <RestartPrompt onRestart={onRestart} />;

  return (
    <div className="flex items-center gap-2">
      {confirming ? (
        <>
          <span className="text-xs text-muted-foreground">Replace current data on restart?</span>
          <button
            type="button"
            onClick={stage}
            disabled={pending}
            className="rounded-md border bg-destructive px-2 py-1 text-xs font-medium text-destructive-foreground disabled:opacity-50"
          >
            {pending ? "Staging…" : "Confirm restore"}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="rounded-md border px-2 py-1 text-xs"
          >
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="rounded-md border px-2 py-1 text-xs font-medium"
        >
          Restore
        </button>
      )}
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}

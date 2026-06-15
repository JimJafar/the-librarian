"use client";

import { useState, useTransition } from "react";
import { RestartPrompt } from "./restart-prompt";
import type { RestartResult, StageRestoreResult } from "@/app/settings/backups/actions";
import { Button } from "@/components/ui-v2/button";

// Restore from backup — editorial rebuild. Inline confirm row (matching
// the curator Delete-provider + auth Pause patterns); on stage success
// the prompt transforms into the copper RestartPrompt.

export function RestoreButton({
  onStage,
  onRestart,
  canRestore,
}: {
  onStage: () => Promise<StageRestoreResult>;
  onRestart: () => Promise<RestartResult>;
  /** True when a backup REMOTE is configured (repo + token resolvable) — the real
   *  precondition for staging a restore. It does NOT require a prior successful run
   *  here: a fresh deployment restoring from an existing remote has none, and
   *  gating on local run history made the button impossible to use after a host
   *  migration. */
  canRestore: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [staged, setStaged] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stage = () =>
    startTransition(async () => {
      setError(null);
      const res = await onStage();
      if (res.ok) {
        setStaged(res.staged);
        setConfirming(false);
      } else {
        setError(res.error);
      }
    });

  if (staged) return <RestartPrompt onRestart={onRestart} stagedFrom={staged} />;

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          Error: {error}
        </p>
      ) : null}
      {confirming ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-foreground/80">
            Clone the latest backup and replace your current vault on the next restart?
          </span>
          <Button
            type="button"
            variant="outline"
            onClick={() => setConfirming(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button type="button" variant="destructive" disabled={pending} onClick={stage}>
            {pending ? "Cloning…" : "Confirm restore"}
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          className="self-start"
          onClick={() => setConfirming(true)}
          disabled={!canRestore}
          title={
            canRestore ? undefined : "Configure a backup repository + token first (Target, above)."
          }
        >
          Restore from backup…
        </Button>
      )}
    </div>
  );
}

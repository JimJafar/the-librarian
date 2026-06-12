"use client";

// The vault activity feed (rethink T21, spec §8 / D16) — the audit trail:
// recent vault commits with the files each touched and a provenance badge
// derived server-side from the commit-subject conventions (agent / curator /
// admin / system). This view replaces the retired event ledger's logs view.
//
// Each entry offers "Restore vault to here", behind the D16 ceremony: a modal
// that states what changes and makes the admin TYPE the confirmation phrase
// (the server validates it again — the UI can't be the only gate). The
// success state shows the pre-restore safety tag the server left behind.

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { RestoreVaultResult } from "@/app/vault/activity/actions";
import { Button } from "@/components/ui-v2/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui-v2/dialog";
import { Input } from "@/components/ui-v2/input";
import type { VaultActivityEntry } from "@/components/vault/types";

/** What the admin must type — mirrors the server's RESTORE_CONFIRMATION_PHRASE. */
export const RESTORE_PHRASE = "RESTORE";

export type RestoreVaultActionFn = (input: {
  hash: string;
  confirm: string;
}) => Promise<RestoreVaultResult>;

const SOURCE_BADGE: Record<string, string> = {
  agent: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
  curator: "bg-violet-500/10 text-violet-700 dark:text-violet-400",
  admin: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  system: "bg-muted text-muted-foreground",
  other: "bg-muted text-muted-foreground",
};

export function ActivityFeed({
  entries,
  onRestore,
}: {
  entries: VaultActivityEntry[];
  onRestore: RestoreVaultActionFn;
}) {
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">No vault commits yet.</p>;
  }
  return (
    <ol aria-label="Vault activity" className="flex flex-col gap-2">
      {entries.map((entry) => (
        <li key={entry.hash} className="rounded-md border bg-card p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-sm px-1.5 py-0.5 text-xs uppercase ${SOURCE_BADGE[entry.source] ?? SOURCE_BADGE.other}`}
            >
              {entry.source}
            </span>
            <span className="font-medium text-foreground">{entry.subject}</span>
            <span className="ml-auto flex items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground">
                {entry.hash.slice(0, 12)} · {formatDate(entry.date)}
              </span>
              <RestoreVaultDialog entry={entry} onRestore={onRestore} />
            </span>
          </div>
          {entry.files.length > 0 ? (
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
              {entry.files.join("  ·  ")}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function formatDate(iso: string): string {
  return iso.replace("T", " ").slice(0, 16);
}

function RestoreVaultDialog({
  entry,
  onRestore,
}: {
  entry: VaultActivityEntry;
  onRestore: RestoreVaultActionFn;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ preRestoreTag: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const result = await onRestore({ hash: entry.hash, confirm });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setDone({ preRestoreTag: result.preRestoreTag });
      router.refresh();
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setConfirm("");
          setError(null);
          setDone(null);
        }
      }}
    >
      <Button variant="outline" onClick={() => setOpen(true)}>
        Restore vault to here
      </Button>
      <DialogContent>
        {done ? (
          <>
            <DialogHeader>
              <DialogTitle>Vault restored</DialogTitle>
              <DialogDescription>
                Every vault file now matches commit {entry.hash.slice(0, 12)}, written as one new
                commit. The pre-restore state is tagged{" "}
                <code className="font-mono">{done.preRestoreTag}</code> — restore to it from this
                feed if you change your mind.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="primary" onClick={() => setOpen(false)}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Restore the whole vault?</DialogTitle>
              <DialogDescription>
                Every vault file is rolled back to its state at {entry.hash.slice(0, 12)} (
                {entry.subject}) — files created since will be removed, edits reverted. The change
                lands as ONE new commit (history is never rewritten) and a pre-restore tag marks the
                current state. The curator pauses while it runs. Type {RESTORE_PHRASE} to confirm.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={submit} className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-sm">
                Confirmation
                <Input
                  variant="mono"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder={RESTORE_PHRASE}
                  aria-label="Restore confirmation"
                />
              </label>
              {error ? (
                <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={pending || confirm !== RESTORE_PHRASE}
                >
                  {pending ? "Restoring…" : "Restore vault"}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

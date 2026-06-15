"use client";

// The vault activity feed (rethink T21, spec §8 / D16) — editorial rebuild.
// Recent vault commits with the files each touched and a provenance Pill
// derived server-side from the commit-subject conventions (agent / curator /
// admin / system). One bordered container with hairline-separated commits;
// each row has a destructive "Restore vault to here" that opens the typed-
// phrase ceremony before arming.

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
import { Pill } from "@/components/ui-v2/pill";
import { SectionLabel } from "@/components/ui-v2/section-label";
import type { VaultActivityEntry } from "@/components/vault/types";

/** What the admin must type — mirrors the server's RESTORE_CONFIRMATION_PHRASE. */
export const RESTORE_PHRASE = "RESTORE";

export type RestoreVaultActionFn = (input: {
  hash: string;
  confirm: string;
}) => Promise<RestoreVaultResult>;

// Map the schema-defined sources onto the brand palette. Curator (verdigris
// accent) is the only source that ever auto-applies vault changes; admin
// (sage muted) is the human; everything else stays in the neutral mono
// register so the label carries the distinction, not the color.
type Source = VaultActivityEntry["source"];
const SOURCE_VARIANT: Record<Source, "default" | "accent" | "muted"> = {
  agent: "default",
  curator: "accent",
  admin: "muted",
  system: "default",
  other: "default",
};

export function ActivityFeed({
  entries,
  onRestore,
}: {
  entries: VaultActivityEntry[];
  onRestore: RestoreVaultActionFn;
}) {
  if (entries.length === 0) {
    return <p className="text-sm text-foreground/60">No vault commits yet.</p>;
  }
  return (
    <ol
      aria-label="Vault activity"
      className="flex flex-col border border-ink-hairline bg-ink-surface"
    >
      {entries.map((entry, i) => (
        <li
          key={entry.hash}
          className={`flex flex-col gap-1.5 px-4 py-3 text-sm ${
            i > 0 ? "border-t border-ink-hairline" : ""
          }`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Pill variant={SOURCE_VARIANT[entry.source] ?? "default"}>{entry.source}</Pill>
            <span className="min-w-0 flex-1 truncate text-foreground" title={entry.subject}>
              {entry.subject}
            </span>
            <span className="flex items-center gap-2 whitespace-nowrap">
              <span
                className="font-mono text-xs text-foreground/60"
                title={`${entry.hash} · ${entry.date}`}
              >
                {entry.hash.slice(0, 12)} · {formatDate(entry.date)}
              </span>
              <RestoreVaultDialog entry={entry} onRestore={onRestore} />
            </span>
          </div>
          {entry.files.length > 0 ? (
            <p className="break-all font-mono text-xs text-foreground/60">
              {entry.files.join("  ·  ")}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function formatDate(iso: string): string {
  // ISO → '2026-06-12 10:00' — date + minutes, locale-agnostic so the
  // audit trail reads the same across viewers (timestamps drive ordering,
  // not casual reading).
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
                Every vault file now matches commit{" "}
                <code className="font-mono text-foreground/80">{entry.hash.slice(0, 12)}</code>,
                written as one new commit. The pre-restore state is tagged{" "}
                <code className="font-mono text-foreground/80">{done.preRestoreTag}</code> — restore
                to it from this feed if you change your mind.
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
                Every vault file is rolled back to its state at{" "}
                <code className="font-mono text-foreground/80">{entry.hash.slice(0, 12)}</code> (
                {entry.subject}) — files created since will be removed, edits reverted. The change
                lands as ONE new commit (history is never rewritten) and a pre-restore tag marks the
                current state. The curator pauses while it runs. Type{" "}
                <code className="font-mono text-foreground">{RESTORE_PHRASE}</code> to confirm.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={submit} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <SectionLabel as="label" htmlFor="restore-confirm">
                  Confirmation
                </SectionLabel>
                <Input
                  id="restore-confirm"
                  variant="mono"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder={RESTORE_PHRASE}
                  aria-label="Restore confirmation"
                />
              </div>
              {error ? (
                <p
                  role="alert"
                  className="whitespace-pre-wrap border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
                >
                  {error}
                </p>
              ) : null}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="destructive"
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

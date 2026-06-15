"use client";

// The vault activity feed (rethink T21, spec §8 / D16). Editorial rebuild
// (rc.19): each commit row is now an accordion — click to expand and
// lazy-load the per-file diffs the commit introduced. Replaces the inline
// file-list line, which only told the operator *which* files changed; the
// accordion shows *what* changed.
//
// Each row carries a destructive "Restore vault to here" that opens the
// typed-phrase ceremony before arming.

import { ChevronRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type {
  CommitDiffFileShape,
  CommitDiffResult,
  RestoreVaultResult,
} from "@/app/vault/activity/actions";
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
import { DiffView } from "@/components/vault/diff-view";
import type { VaultActivityEntry } from "@/components/vault/types";

/** What the admin must type — mirrors the server's RESTORE_CONFIRMATION_PHRASE. */
export const RESTORE_PHRASE = "RESTORE";

export type RestoreVaultActionFn = (input: {
  hash: string;
  confirm: string;
}) => Promise<RestoreVaultResult>;

export type CommitDiffActionFn = (input: { hash: string }) => Promise<CommitDiffResult>;

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

const STATUS_LABEL: Record<CommitDiffFileShape["status"], string> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
};

export function ActivityFeed({
  entries,
  onRestore,
  onCommitDiff,
}: {
  entries: VaultActivityEntry[];
  onRestore: RestoreVaultActionFn;
  onCommitDiff: CommitDiffActionFn;
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
        <li key={entry.hash} className={i > 0 ? "border-t border-ink-hairline" : ""}>
          <CommitRow entry={entry} onRestore={onRestore} onCommitDiff={onCommitDiff} />
        </li>
      ))}
    </ol>
  );
}

function CommitRow({
  entry,
  onRestore,
  onCommitDiff,
}: {
  entry: VaultActivityEntry;
  onRestore: RestoreVaultActionFn;
  onCommitDiff: CommitDiffActionFn;
}) {
  const [expanded, setExpanded] = useState(false);
  const [files, setFiles] = useState<CommitDiffFileShape[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const regionId = `commit-${entry.hash.slice(0, 12)}`;

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    // Lazy-load the diff the first time the row opens. Cached for subsequent
    // toggles — re-collapsing keeps the data so re-opening is instant.
    if (next && files === null && !pending) {
      startTransition(async () => {
        const result = await onCommitDiff({ hash: entry.hash });
        if (result.ok) setFiles(result.files);
        else setError(result.error);
      });
    }
  };

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-1.5 px-4 py-3 text-sm">
        <div className="flex items-start gap-2">
          <button
            type="button"
            onClick={toggle}
            aria-expanded={expanded}
            aria-controls={regionId}
            aria-label={`${expanded ? "Hide" : "Show"} diff for commit ${entry.hash.slice(0, 12)}`}
            className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center text-foreground/40 transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent"
          >
            <ChevronRight
              aria-hidden
              className={`h-4 w-4 transition-transform motion-reduce:transition-none ${
                expanded ? "rotate-90" : ""
              }`}
            />
          </button>
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
          <p className="break-all pl-7 font-mono text-xs text-foreground/60">
            {entry.files.join("  ·  ")}
          </p>
        ) : null}
      </div>

      {expanded ? (
        <div
          id={regionId}
          role="region"
          aria-label={`Changes in ${entry.hash.slice(0, 12)}`}
          className="flex flex-col gap-4 border-t border-ink-hairline bg-foreground/[0.02] px-4 py-4"
        >
          {pending ? (
            <p className="text-sm text-foreground/60">Loading diff…</p>
          ) : error ? (
            <p
              role="alert"
              className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
            >
              {error}
            </p>
          ) : files === null ? null : files.length === 0 ? (
            <p className="text-sm text-foreground/60">
              No file diffs recorded for this commit. (Empty commit, or binary-only changes.)
            </p>
          ) : (
            files.map((file) => <FileDiffSection key={file.path} file={file} />)
          )}
        </div>
      ) : null}
    </div>
  );
}

function FileDiffSection({ file }: { file: CommitDiffFileShape }) {
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-label={`${file.path} (${file.status})`}>
      <header className="flex flex-wrap items-baseline gap-2 text-sm">
        <SectionLabel as="span">{STATUS_LABEL[file.status]}</SectionLabel>
        <span className="font-mono text-xs text-foreground" title={file.path}>
          {file.path}
        </span>
        {file.fromPath ? (
          <span className="font-mono text-xs text-foreground/55" title={file.fromPath}>
            (was {file.fromPath})
          </span>
        ) : null}
      </header>
      <DiffView diff={file.diff} />
    </section>
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

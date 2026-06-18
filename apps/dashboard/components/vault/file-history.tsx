"use client";

// Per-file history panel (rethink T20, spec §8 / D16): the file's commit list
// (newest first, rename-following), a unified-diff view per version ("what
// this commit changed" — diffed against the previous version in the file's
// history), and "Restore this version" behind a confirm dialog. Restores land
// server-side as a NEW commit through the validated store write path; a
// version that no longer validates comes back as the server's teaching error.
//
// The diff renders as a plain <pre> with +/- line colouring — deliberately
// dependency-free, consistent with the dashboard's existing markdown-and-
// tailwind posture.

import { ChevronRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type {
  FileDiffResult,
  FileHistoryResult,
  VaultActionResult,
  VaultFileCommit,
} from "@/app/vault/actions";
import { Button } from "@/components/ui-v2/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui-v2/dialog";
import { DiffView } from "@/components/vault/diff-view";

// Re-export under the original name for the existing tests that imported
// DiffView from this module (it now lives next to it under diff-view.tsx).
export { DiffView };

export interface HistoryActions {
  history: (input: { path: string }) => Promise<FileHistoryResult>;
  diff: (input: { path: string; from?: string; to?: string }) => Promise<FileDiffResult>;
  restoreVersion: (input: { path: string; hash: string }) => Promise<VaultActionResult>;
}

export function FileHistory({ path, actions }: { path: string; actions: HistoryActions }) {
  const [commits, setCommits] = useState<VaultFileCommit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    void actions.history({ path }).then((result) => {
      if (cancelled) return;
      if (result.ok) setCommits(result.commits);
      else setError(result.error);
    });
    return () => {
      cancelled = true;
    };
    // Reload when the viewed file changes; `actions` is a stable module fn set,
    // deliberately out of the deps so an inline-object caller can't loop this.
  }, [path]);

  // Accordion: a commit row expands in place and loads its diff inline. The old
  // two-column layout gave the unwrapped diff <pre> its own always-on column,
  // and a long line blew that column (and the Restore button) past the
  // viewport. Inline-on-demand keeps history single-column at every width; one
  // row open at a time, re-clicking the open row collapses it.
  const toggle = (commit: VaultFileCommit) => {
    if (expanded === commit.hash) {
      setExpanded(null);
      setDiff(null);
      return;
    }
    setExpanded(commit.hash);
    setDiff(null);
    startTransition(async () => {
      // "What this version changed": diff from the previous version in the
      // file's own history; the oldest commit diffs from the file's birth.
      const index = commits?.findIndex((c) => c.hash === commit.hash) ?? -1;
      const previous = index >= 0 ? commits?.[index + 1] : undefined;
      const result = await actions.diff({
        path,
        ...(previous ? { from: previous.hash } : {}),
        to: commit.hash,
      });
      if (result.ok) setDiff(result.diff);
      else setError(result.error);
    });
  };

  if (error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    );
  }
  if (commits === null) return <p className="text-sm text-muted-foreground">Loading history…</p>;
  if (commits.length === 0) {
    return <p className="text-sm text-muted-foreground">No commits touch this file yet.</p>;
  }

  return (
    <ol aria-label="File history" className="flex min-w-0 flex-col border-t border-ink-hairline">
      {commits.map((commit, index) => {
        const isOpen = expanded === commit.hash;
        // Commits are newest-first, so index 0 is the current version — there's
        // nothing to restore it to, so the Restore action is hidden there.
        const isLatest = index === 0;
        const regionId = `commit-${commit.hash.slice(0, 12)}`;
        return (
          <li key={commit.hash} className="border-b border-ink-hairline">
            <button
              type="button"
              onClick={() => toggle(commit)}
              aria-expanded={isOpen}
              aria-controls={regionId}
              className="flex w-full items-start gap-2.5 py-2.5 text-left transition-colors hover:bg-foreground/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink-accent"
            >
              <ChevronRight
                aria-hidden
                className={`mt-0.5 h-4 w-4 shrink-0 text-foreground/40 transition-transform motion-reduce:transition-none ${
                  isOpen ? "rotate-90" : ""
                }`}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground">{commit.subject}</span>
                <span className="block font-mono text-xs text-foreground/50">
                  {commit.hash.slice(0, 12)} · {formatDate(commit.date)}
                </span>
              </span>
            </button>
            {isOpen ? (
              <div
                id={regionId}
                role="region"
                aria-label={`Changes in ${commit.hash.slice(0, 12)}`}
                className="min-w-0 pb-3 pl-[26px]"
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-foreground/50">
                    What this version changed
                  </span>
                  {isLatest ? null : (
                    <RestoreVersionDialog
                      path={path}
                      hash={commit.hash}
                      onRestore={actions.restoreVersion}
                    />
                  )}
                </div>
                {diff === null ? (
                  <p className="text-sm text-muted-foreground">Loading diff…</p>
                ) : (
                  <DiffView diff={diff} />
                )}
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function formatDate(iso: string): string {
  return iso.replace("T", " ").slice(0, 16);
}

function RestoreVersionDialog({
  path,
  hash,
  onRestore,
}: {
  path: string;
  hash: string;
  onRestore: HistoryActions["restoreVersion"];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const confirm = () => {
    startTransition(async () => {
      const result = await onRestore({ path, hash });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setError(null);
      router.refresh();
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setError(null);
      }}
    >
      <Button variant="outline" onClick={() => setOpen(true)}>
        Restore this version
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restore {path}?</DialogTitle>
          <DialogDescription>
            The content from commit {hash.slice(0, 12)} is written back as a new commit — history is
            never rewritten, so the current version stays recoverable.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={confirm} disabled={pending}>
            {pending ? "Restoring…" : "Restore version"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

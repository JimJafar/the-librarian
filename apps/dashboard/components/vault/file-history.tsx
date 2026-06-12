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

export interface HistoryActions {
  history: (input: { path: string }) => Promise<FileHistoryResult>;
  diff: (input: { path: string; from?: string; to?: string }) => Promise<FileDiffResult>;
  restoreVersion: (input: { path: string; hash: string }) => Promise<VaultActionResult>;
}

export function FileHistory({ path, actions }: { path: string; actions: HistoryActions }) {
  const [commits, setCommits] = useState<VaultFileCommit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
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

  const select = (commit: VaultFileCommit) => {
    setSelected(commit.hash);
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
    <div className="grid gap-6 lg:grid-cols-[1fr_2fr]">
      <ol aria-label="File history" className="flex flex-col gap-1 text-sm">
        {commits.map((commit) => (
          <li key={commit.hash}>
            <button
              type="button"
              onClick={() => select(commit)}
              aria-current={selected === commit.hash ? "true" : undefined}
              className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
                selected === commit.hash ? "border-foreground bg-muted" : "bg-card hover:bg-muted"
              }`}
            >
              <span className="block truncate font-medium text-foreground">{commit.subject}</span>
              <span className="block font-mono text-xs text-muted-foreground">
                {commit.hash.slice(0, 12)} · {formatDate(commit.date)}
              </span>
            </button>
          </li>
        ))}
      </ol>
      <section aria-label="Version detail" className="flex flex-col gap-3">
        {selected === null ? (
          <p className="text-sm text-muted-foreground">
            Select a commit to see what that version changed.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground">
                {selected.slice(0, 12)}
              </span>
              <span className="ml-auto">
                <RestoreVersionDialog
                  path={path}
                  hash={selected}
                  onRestore={actions.restoreVersion}
                />
              </span>
            </div>
            {diff === null ? (
              <p className="text-sm text-muted-foreground">Loading diff…</p>
            ) : (
              <DiffView diff={diff} />
            )}
          </>
        )}
      </section>
    </div>
  );
}

function formatDate(iso: string): string {
  return iso.replace("T", " ").slice(0, 16);
}

/** Unified diff as a <pre> with per-line +/- colouring (no diff dependency). */
export function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) {
    return <p className="text-sm text-muted-foreground">No changes — versions are identical.</p>;
  }
  return (
    <pre
      aria-label="Unified diff"
      className="overflow-x-auto rounded-md border bg-card p-3 font-mono text-xs leading-5"
    >
      {diff.split("\n").map((line, index) => (
        <span key={index} className={`block whitespace-pre ${diffLineClass(line)}`}>
          {line || " "}
        </span>
      ))}
    </pre>
  );
}

function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-muted-foreground";
  if (line.startsWith("@@")) return "text-sky-600 dark:text-sky-400";
  if (line.startsWith("+")) return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
  if (line.startsWith("-")) return "bg-red-500/10 text-red-700 dark:text-red-400";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "text-muted-foreground";
  return "text-foreground";
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

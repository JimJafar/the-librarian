"use client";

// The vault explorer layout (rethink T18/T19): tree sidebar + file panel.
// Pure composition — the page fetched everything server-side; this component
// owns only the "new file" dialog and hands the selected file to FileView.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui-v2/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui-v2/dialog";
import { Input } from "@/components/ui-v2/input";
import { FileTree } from "@/components/vault/file-tree";
import { FileView } from "@/components/vault/file-view";
import type { VaultActions } from "@/components/vault/file-view";
import type { VaultFile, VaultTreeNode } from "@/components/vault/types";

export function VaultExplorer({
  tree,
  treeError,
  selectedPath,
  file,
  fileError,
  actions,
}: {
  tree: VaultTreeNode[];
  treeError: string | null;
  selectedPath: string | null;
  file: VaultFile | null;
  fileError: string | null;
  actions: VaultActions;
}) {
  return (
    <div className="grid gap-6 md:grid-cols-[260px_1fr]">
      <aside className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h1 className="font-display text-xl text-foreground">Vault</h1>
          <NewFileDialog onCreate={actions.create} />
        </div>
        {/* The audit trail (rethink T21): the vault's git history + restore. */}
        <Link href="/vault/activity" className="text-sm underline">
          Activity
        </Link>
        {treeError ? (
          <p className="text-sm text-destructive">{treeError}</p>
        ) : (
          <nav
            aria-label="Vault tree"
            className="border border-ink-hairline bg-ink-surface p-2 text-sm"
          >
            <FileTree nodes={tree} selectedPath={selectedPath} />
          </nav>
        )}
      </aside>
      <section className="min-w-0">
        {fileError ? (
          <p className="text-sm text-destructive">{fileError}</p>
        ) : file ? (
          <FileView file={file} actions={actions} />
        ) : (
          <p className="text-sm text-foreground/60">
            Select a file to view it — memories, handoffs, references, curator addendums, and the
            primer all live here.
          </p>
        )}
      </section>
    </div>
  );
}

function NewFileDialog({ onCreate }: { onCreate: VaultActions["create"] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [raw, setRaw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const result = await onCreate({ path: path.trim(), raw });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setError(null);
      router.push(`/vault?path=${encodeURIComponent(path.trim())}`);
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" onClick={() => setOpen(true)}>
        New file
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New vault file</DialogTitle>
          <DialogDescription>
            A vault-relative markdown path (e.g. references/style-guide.md). Memories and handoffs
            are validated against their schemas on save.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Path
            <Input
              variant="mono"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="references/new-doc.md"
              aria-label="New file path"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Content
            <textarea
              aria-label="New file content"
              className="min-h-[120px] border border-ink-hairline bg-ink-mono-fill p-2 font-mono text-xs text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
            />
          </label>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending || !path.trim()}>
              {pending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

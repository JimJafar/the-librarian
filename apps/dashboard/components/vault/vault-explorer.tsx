"use client";

// The vault explorer layout (rethink T18/T19): tree sidebar + file panel.
// Pure composition — the page fetched everything server-side; this component
// owns the "new file" dialog and the j/k tree-navigation hook, and hands the
// selected file to FileView.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
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
import { KeyHint } from "@/components/ui-v2/key-hint";
import { FileTree } from "@/components/vault/file-tree";
import { FileView } from "@/components/vault/file-view";
import type { VaultActions } from "@/components/vault/file-view";
import type { VaultFile, VaultTreeNode } from "@/components/vault/types";

/** Pre-order flatten of the tree to a stable list of file paths — the
 *  shape j/k navigation needs. Directory nodes themselves aren't
 *  selectable (they're container affordances), so we skip them. */
function flattenFiles(nodes: VaultTreeNode[]): string[] {
  const out: string[] = [];
  const walk = (list: VaultTreeNode[]) => {
    for (const node of list) {
      if (node.type === "dir") {
        if (node.children) walk(node.children);
      } else {
        out.push(node.path);
      }
    }
  };
  walk(nodes);
  return out;
}

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
  const router = useRouter();
  const flatPaths = useMemo(() => flattenFiles(tree), [tree]);
  const newFileTriggerRef = useRef<HTMLButtonElement | null>(null);

  // j/k cycles the selected file through the flattened tree. No selection
  // yet (?path= unset) lands on the first file. Wraps at both ends — vim
  // convention and easier to learn than "stop at the end."
  const move = useCallback(
    (delta: 1 | -1) => {
      if (flatPaths.length === 0) return;
      const currentIndex = selectedPath ? flatPaths.indexOf(selectedPath) : -1;
      const nextIndex =
        currentIndex === -1
          ? delta === 1
            ? 0
            : flatPaths.length - 1
          : (currentIndex + delta + flatPaths.length) % flatPaths.length;
      const nextPath = flatPaths[nextIndex];
      if (!nextPath) return; // unreachable given the empty-list guard above, but keeps the type narrow.
      router.push(`/vault?path=${encodeURIComponent(nextPath)}`);
    },
    [flatPaths, selectedPath, router],
  );

  // Vault-page shortcuts: N opens New file; J / K move down / up through
  // the file list. Skip when focus is in an input or contenteditable.
  useEffect(() => {
    function handler(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "n") {
        event.preventDefault();
        newFileTriggerRef.current?.click();
      } else if (key === "j") {
        event.preventDefault();
        move(1);
      } else if (key === "k") {
        event.preventDefault();
        move(-1);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [move]);

  return (
    <div className="grid gap-6 md:grid-cols-[260px_1fr]">
      <aside className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h1 className="font-display text-xl text-foreground">Vault</h1>
          <NewFileDialog onCreate={actions.create} triggerRef={newFileTriggerRef} />
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

function NewFileDialog({
  onCreate,
  triggerRef,
}: {
  onCreate: VaultActions["create"];
  triggerRef?: React.Ref<HTMLButtonElement>;
}) {
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
      <Button ref={triggerRef} variant="outline" onClick={() => setOpen(true)}>
        New file
        <KeyHint shortcut="N" />
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

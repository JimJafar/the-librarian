"use client";

// The vault explorer layout (rethink T18): tree sidebar + file panel.
// Pure composition — the page fetched everything server-side.

import { FileTree } from "@/components/vault/file-tree";
import { FileView } from "@/components/vault/file-view";
import type { VaultFile, VaultTreeNode } from "@/components/vault/types";

export function VaultExplorer({
  tree,
  treeError,
  selectedPath,
  file,
  fileError,
}: {
  tree: VaultTreeNode[];
  treeError: string | null;
  selectedPath: string | null;
  file: VaultFile | null;
  fileError: string | null;
}) {
  return (
    <div className="grid gap-6 md:grid-cols-[260px_1fr]">
      <aside className="flex flex-col gap-3">
        <h1 className="font-display text-xl text-foreground">Vault</h1>
        {treeError ? (
          <p className="text-sm text-destructive">{treeError}</p>
        ) : (
          <nav aria-label="Vault tree" className="rounded-md border bg-card p-2 text-sm">
            <FileTree nodes={tree} selectedPath={selectedPath} />
          </nav>
        )}
      </aside>
      <section>
        {fileError ? (
          <p className="text-sm text-destructive">{fileError}</p>
        ) : file ? (
          <FileView file={file} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Select a file to view it — memories, handoffs, references, curator addendums, and the
            primer all live here.
          </p>
        )}
      </section>
    </div>
  );
}

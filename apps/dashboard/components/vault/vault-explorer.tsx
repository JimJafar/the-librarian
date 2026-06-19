"use client";

// The vault explorer layout (rethink T18/T19): tree sidebar + file panel.
// Pure composition — the page fetched everything server-side; this component
// owns the "new file" dialog and the j/k tree-navigation hook, and hands the
// selected file to FileView.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import { EmptyState } from "@/components/brand/empty-state";
import { KeyHint } from "@/components/ui-v2/key-hint";
import { FileTree } from "@/components/vault/file-tree";
import { FileView } from "@/components/vault/file-view";
import type { VaultActions } from "@/components/vault/file-view";
import { NewFileDialog } from "@/components/vault/new-file-dialog";
import type { VaultFile, VaultTreeNode } from "@/components/vault/types";
import { useSurfaceShortcuts } from "@/hooks/use-surface-shortcuts";

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

/** Prune the tree to the nodes whose full path matches `query` (case-
 *  insensitive substring on the file path). Directories with at least
 *  one matching descendant are kept (with the matching subset only) so
 *  the user sees the path context, not a flat result list. Exported
 *  for direct unit testing — the visual filter is just a thin shell
 *  around this function. */
export function filterTree(nodes: VaultTreeNode[], query: string): VaultTreeNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  const walk = (list: VaultTreeNode[]): VaultTreeNode[] => {
    const out: VaultTreeNode[] = [];
    for (const node of list) {
      if (node.type === "dir") {
        const kids = walk(node.children ?? []);
        if (kids.length > 0) out.push({ ...node, children: kids });
      } else if (node.path.toLowerCase().includes(q)) {
        out.push(node);
      }
    }
    return out;
  };
  return walk(nodes);
}

/** Every directory path in the tree, plus the vault root (""), sorted with root
 *  first — the option list for the New-file and Move path pickers. Exported for
 *  direct unit testing. */
export function collectDirectories(nodes: VaultTreeNode[]): string[] {
  const dirs: string[] = [];
  const walk = (list: VaultTreeNode[]): void => {
    for (const node of list) {
      if (node.type === "dir") {
        dirs.push(node.path);
        if (node.children) walk(node.children);
      }
    }
  };
  walk(nodes);
  return ["", ...dirs.sort()];
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
  const [filter, setFilter] = useState("");
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  const newFileTriggerRef = useRef<HTMLButtonElement | null>(null);

  // Filter prunes the tree; j/k navigation follows the visible (filtered)
  // list so cycling never lands on a hidden file. With an empty filter
  // both memos pass through unchanged.
  const filteredTree = useMemo(() => filterTree(tree, filter), [tree, filter]);
  const flatPaths = useMemo(() => flattenFiles(filteredTree), [filteredTree]);
  // Folder option list for the path pickers (New file + Move) — from the full
  // tree, not the filtered view, so placement choices aren't narrowed by the
  // sidebar filter.
  const directories = useMemo(() => collectDirectories(tree), [tree]);

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
      router.push(`/?path=${encodeURIComponent(nextPath)}`);
    },
    [flatPaths, selectedPath, router],
  );

  // Vault-page shortcuts: N opens New file; J / K cycle the filtered
  // list; `/` jumps focus to the filter (vim / GitHub convention). The
  // hook handles skip-when-in-input / skip-when-modifier-held / event
  // preventDefault for us.
  useSurfaceShortcuts({
    n: () => newFileTriggerRef.current?.click(),
    j: () => move(1),
    k: () => move(-1),
    "/": () => {
      filterInputRef.current?.focus();
      filterInputRef.current?.select();
    },
  });

  return (
    <div className="grid gap-6 md:grid-cols-[260px_1fr]">
      <aside className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h1 className="font-display text-xl text-foreground">Vault</h1>
          <NewFileDialog
            onCreate={actions.create}
            directories={directories}
            triggerRef={newFileTriggerRef}
          />
        </div>
        {/* The audit trail (rethink T21): the vault's git history + restore. */}
        <Link href="/activity" className="text-sm underline">
          Activity
        </Link>
        {treeError ? (
          <p className="text-sm text-destructive">{treeError}</p>
        ) : (
          <>
            <div className="relative">
              <input
                ref={filterInputRef}
                type="search"
                aria-label="Filter vault by path"
                placeholder="Filter…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setFilter("");
                    e.currentTarget.blur();
                  }
                }}
                className="w-full border border-ink-hairline bg-ink-surface px-2 py-1.5 font-mono text-xs text-foreground placeholder:text-foreground/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink-accent pointer-coarse:min-h-11 pointer-coarse:py-2.5 pointer-coarse:text-sm"
              />
              {filter ? (
                <button
                  type="button"
                  aria-label="Clear filter"
                  onClick={() => {
                    setFilter("");
                    filterInputRef.current?.focus();
                  }}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 px-1.5 py-0.5 font-mono text-xs text-foreground/60 hover:text-foreground"
                >
                  ✕
                </button>
              ) : (
                <span
                  aria-hidden
                  className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 pointer-coarse:hidden"
                >
                  <KeyHint shortcut="/" />
                </span>
              )}
            </div>
            <nav
              aria-label="Vault tree"
              // On mobile the tree sits above the file content; capping its
              // height once a file is open keeps the content above the
              // fold instead of forcing the user to scroll past 30 rows.
              // Desktop (md+) returns to the natural full-height tree.
              className={`border border-ink-hairline bg-ink-surface p-2 text-sm md:max-h-none md:overflow-visible ${
                selectedPath ? "max-h-60 overflow-y-auto" : ""
              }`}
            >
              {filteredTree.length === 0 ? (
                <p className="px-2 py-1 text-foreground/60">
                  No files match{" "}
                  <span className="font-mono text-foreground">&ldquo;{filter}&rdquo;</span>.
                </p>
              ) : (
                <FileTree
                  nodes={filteredTree}
                  selectedPath={selectedPath}
                  // Filter active → force every dir open so matches inside
                  // collapsed dirs become visible without the user clicking
                  // through. Idle → respect user's collapse state.
                  forceOpen={filter.trim().length > 0}
                />
              )}
            </nav>
          </>
        )}
      </aside>
      <section className="min-w-0">
        {fileError ? (
          <p className="text-sm text-destructive">{fileError}</p>
        ) : file ? (
          <FileView file={file} actions={actions} directories={directories} />
        ) : (
          <EmptyState title="The vault, at rest.">
            <p>
              The librarian is waiting. Pick a file from the tree to read it — memories, handoffs,
              references, curator addendums, and the primer all live here. New files land in the
              same store the agents read from; everything is git-backed and recoverable.
            </p>
            <p className="mt-3 font-mono text-xs text-foreground/55">
              Press <span className="text-foreground/80">/</span> to filter ·{" "}
              <span className="text-foreground/80">N</span> to start a new file ·{" "}
              <span className="text-foreground/80">J / K</span> to step through.
            </p>
          </EmptyState>
        )}
      </section>
    </div>
  );
}

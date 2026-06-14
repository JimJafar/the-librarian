"use client";

// The vault tree sidebar (rethink T18): directories as collapsible groups,
// files as links that select via the `?path=` search param. Server-sorted
// (dirs first, then name); the component renders, never re-orders.

import Link, { useLinkStatus } from "next/link";
import type { VaultTreeNode } from "@/components/vault/types";

/** Subtle row-level loading dot — shows only while THIS row's Link is
 *  resolving its destination. Renders a thin animated vermilion dot to
 *  the right of the name. `useLinkStatus` is only valid as a descendant
 *  of a Link, hence the inner component. */
function RowPending() {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return (
    <span
      aria-hidden
      className="ml-auto inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-ink-accent motion-reduce:animate-none"
    />
  );
}

export function FileTree({
  nodes,
  selectedPath,
  forceOpen = false,
}: {
  nodes: VaultTreeNode[];
  selectedPath: string | null;
  /** When true, every `<details>` directory is rendered open regardless
   *  of any prior user-collapse — used while a filter is active so a
   *  match inside a collapsed dir is still visible. */
  forceOpen?: boolean;
}) {
  if (nodes.length === 0) {
    return <p className="px-2 py-1 text-foreground/60">The vault is empty.</p>;
  }
  return (
    <ul className="flex flex-col">
      {nodes.map((node) => (
        <TreeNode key={node.path} node={node} selectedPath={selectedPath} forceOpen={forceOpen} />
      ))}
    </ul>
  );
}

function TreeNode({
  node,
  selectedPath,
  forceOpen,
}: {
  node: VaultTreeNode;
  selectedPath: string | null;
  forceOpen: boolean;
}) {
  if (node.type === "dir") {
    // Default: render `<details open>` (open by default, user can collapse).
    // When `forceOpen` is true we re-mount via the `key` so any user-applied
    // collapse is discarded and the dir's matches become visible — toggling
    // the `open` attribute imperatively after user interaction desyncs with
    // browser state, so re-mount is the predictable fix.
    return (
      <li>
        <details key={forceOpen ? "forced-open" : "user"} open>
          <summary className="cursor-pointer select-none px-2 py-1 font-medium text-foreground/80 pointer-coarse:min-h-11 pointer-coarse:py-3 pointer-coarse:text-base">
            {node.name}/
          </summary>
          <div className="ml-3 border-l border-ink-hairline pl-1">
            <FileTree
              nodes={node.children ?? []}
              selectedPath={selectedPath}
              forceOpen={forceOpen}
            />
          </div>
        </details>
      </li>
    );
  }
  const active = node.path === selectedPath;
  return (
    <li>
      <Link
        href={`/vault?path=${encodeURIComponent(node.path)}`}
        aria-current={active ? "page" : undefined}
        className={`flex min-w-0 items-center gap-2 px-2 py-1 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink-accent pointer-coarse:min-h-11 pointer-coarse:py-3 pointer-coarse:text-base ${
          active
            ? "bg-foreground/[0.06] text-foreground"
            : "text-foreground/60 hover:text-foreground"
        }`}
      >
        <span className="truncate">{node.name}</span>
        <RowPending />
      </Link>
    </li>
  );
}

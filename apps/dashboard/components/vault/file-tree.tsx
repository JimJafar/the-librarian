"use client";

// The vault tree sidebar (rethink T18): directories as collapsible groups,
// files as links that select via the `?path=` search param. Server-sorted
// (dirs first, then name); the component renders, never re-orders.

import Link, { useLinkStatus } from "next/link";
import { MemoryOrb } from "@/components/brand/memory-orb";
import type { VaultTreeNode } from "@/components/vault/types";

/** Subtle row-level loading indicator — shows only while THIS row's Link
 *  is resolving its destination. Renders the brand MemoryOrb (small,
 *  pulsing, with bloom) so "consulting memory" is the reading rather
 *  than a generic spinner dot. `useLinkStatus` is only valid as a
 *  descendant of a Link, hence the inner component. */
function RowPending() {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return <MemoryOrb size={8} pulse className="ml-auto" />;
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
    // Default: render `<details>` collapsed (the user expands what they want).
    // When `forceOpen` is true (an active filter) we re-mount via the `key` and
    // open the dir so its matches are visible — toggling the `open` attribute
    // imperatively after user interaction desyncs with browser state, so
    // re-mount is the predictable fix.
    return (
      <li>
        <details key={forceOpen ? "forced-open" : "user"} open={forceOpen}>
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
    <li className="relative">
      {/* Brass marker on the active row — a 2px gilt tick that says
          "this is the open file" with the structural-hardware accent,
          leaving the rubric accent free for actions. Brass NEVER carries
          state on its own, but here it pairs with the wash + the
          aria-current to read as the structural counterpart to the
          rubric. */}
      {active ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-[2px] bg-ink-copper"
        />
      ) : null}
      <Link
        href={`/?path=${encodeURIComponent(node.path)}`}
        aria-current={active ? "page" : undefined}
        className={`flex min-w-0 items-center gap-2 px-2 py-1 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink-accent pointer-coarse:min-h-11 pointer-coarse:py-3 pointer-coarse:text-base ${
          active
            ? "bg-foreground/[0.06] pl-2.5 text-foreground"
            : "text-foreground/60 hover:text-foreground"
        }`}
      >
        <span className="truncate">{node.name}</span>
        <RowPending />
      </Link>
    </li>
  );
}

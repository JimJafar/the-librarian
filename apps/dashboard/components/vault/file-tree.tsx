"use client";

// The vault tree sidebar (rethink T18): directories as collapsible groups,
// files as links that select via the `?path=` search param. Server-sorted
// (dirs first, then name); the component renders, never re-orders.

import Link from "next/link";
import type { VaultTreeNode } from "@/components/vault/types";

export function FileTree({
  nodes,
  selectedPath,
}: {
  nodes: VaultTreeNode[];
  selectedPath: string | null;
}) {
  if (nodes.length === 0) {
    return <p className="px-2 py-1 text-foreground/60">The vault is empty.</p>;
  }
  return (
    <ul className="flex flex-col">
      {nodes.map((node) => (
        <TreeNode key={node.path} node={node} selectedPath={selectedPath} />
      ))}
    </ul>
  );
}

function TreeNode({ node, selectedPath }: { node: VaultTreeNode; selectedPath: string | null }) {
  if (node.type === "dir") {
    return (
      <li>
        <details open>
          <summary className="cursor-pointer select-none px-2 py-1 font-medium text-foreground/80">
            {node.name}/
          </summary>
          <div className="ml-3 border-l border-ink-hairline pl-1">
            <FileTree nodes={node.children ?? []} selectedPath={selectedPath} />
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
        className={`block truncate px-2 py-1 transition-colors ${
          active
            ? "bg-foreground/[0.06] text-foreground"
            : "text-foreground/60 hover:text-foreground"
        }`}
      >
        {node.name}
      </Link>
    </li>
  );
}

// Vault explorer (rethink T18/T19, spec §8 / D15) — the Obsidian-lite admin
// surface: a tree over the whole vault (memories, handoffs, references,
// .curator/, primer.md) with a file view (rendered markdown, frontmatter
// property table, clickable wikilinks, backlinks pane) and a raw editor.
// Data is fetched server-side per request; the selected file rides the
// `?path=` search param so wikilinks/backlinks are plain navigations.

import {
  createVaultFileAction,
  deleteVaultFileAction,
  renameVaultFileAction,
  saveVaultFileAction,
} from "@/app/vault/actions";
import type { VaultFile, VaultTreeNode } from "@/components/vault/types";
import { VaultExplorer } from "@/components/vault/vault-explorer";
import { serverTRPC } from "@/lib/trpc-server";

export const metadata = { title: "Vault · Librarian" };
export const dynamic = "force-dynamic";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default async function VaultPage({
  searchParams,
}: {
  searchParams: Promise<{ path?: string }>;
}) {
  const { path } = await searchParams;

  let tree: VaultTreeNode[] = [];
  let treeError: string | null = null;
  try {
    tree = await serverTRPC.vault.tree.query();
  } catch (error) {
    treeError = message(error);
  }

  let file: VaultFile | null = null;
  let fileError: string | null = null;
  if (path) {
    try {
      file = await serverTRPC.vault.read.query({ path });
    } catch (error) {
      fileError = message(error);
    }
  }

  return (
    <main className="flex flex-col gap-4 p-6">
      <VaultExplorer
        tree={tree}
        treeError={treeError}
        selectedPath={path ?? null}
        file={file}
        fileError={fileError}
        actions={{
          save: saveVaultFileAction,
          create: createVaultFileAction,
          rename: renameVaultFileAction,
          remove: deleteVaultFileAction,
        }}
      />
    </main>
  );
}

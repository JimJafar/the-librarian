"use server";

// Vault explorer/editor server actions (rethink T19, spec §8 / D15). Thin
// wrappers over the admin vault router: every mutation goes through the
// store layer server-side (per-kind validation, compare-and-swap, git commit
// per write, index invalidation) — these only forward, surface the server's
// teaching errors verbatim, and revalidate the vault view.

import { revalidatePath } from "next/cache";
import { serverTRPC } from "@/lib/trpc-server";

export type VaultActionResult = { ok: true } | { ok: false; error: string };
export type SaveVaultFileResult = { ok: true; hash: string } | { ok: false; error: string };
export type RenameVaultFileResult =
  | { ok: true; path: string; changedLinks: string[] }
  | { ok: false; error: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Save an existing file. `expectedHash` (from the read) makes the save
 * compare-and-swap: a file changed since load comes back as a conflict error,
 * never a silent overwrite. Validation errors arrive as the server's
 * per-kind teaching messages.
 */
export async function saveVaultFileAction(input: {
  path: string;
  raw: string;
  expectedHash: string;
}): Promise<SaveVaultFileResult> {
  try {
    const { hash } = await serverTRPC.vault.write.mutate(input);
    revalidatePath("/vault");
    return { ok: true, hash };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

export async function createVaultFileAction(input: {
  path: string;
  raw: string;
}): Promise<VaultActionResult> {
  try {
    await serverTRPC.vault.create.mutate(input);
    revalidatePath("/vault");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

/** Rename a file; the server rewrites wikilinks targeting the old name. */
export async function renameVaultFileAction(input: {
  from: string;
  to: string;
}): Promise<RenameVaultFileResult> {
  try {
    const result = await serverTRPC.vault.rename.mutate(input);
    revalidatePath("/vault");
    return { ok: true, path: result.path, changedLinks: result.changedLinks };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

/** Delete a file (recoverable from the vault's git history). */
export async function deleteVaultFileAction(input: { path: string }): Promise<VaultActionResult> {
  try {
    await serverTRPC.vault.delete.mutate(input);
    revalidatePath("/vault");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

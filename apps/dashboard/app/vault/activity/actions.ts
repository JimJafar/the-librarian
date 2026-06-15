"use server";

// Whole-vault restore server action (rethink T21, spec §8 / D16). A thin
// wrapper over the admin activity router: the typed confirmation phrase is
// forwarded VERBATIM — the server validates it (the modal's ceremony can't be
// bypassed by skipping the UI), runs the guarded sequence (curator pause →
// pre-restore tag → one revert commit → index invalidation → resume) and the
// teaching errors come back as-is.

import { revalidatePath } from "next/cache";
import { serverTRPC } from "@/lib/trpc-server";

export type RestoreVaultResult =
  | { ok: true; restoredTo: string; preRestoreTag: string; commit: string | null }
  | { ok: false; error: string };

export async function restoreVaultAction(input: {
  hash: string;
  confirm: string;
}): Promise<RestoreVaultResult> {
  try {
    const result = await serverTRPC.activity.restoreVault.mutate(input);
    revalidatePath("/");
    revalidatePath("/activity");
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

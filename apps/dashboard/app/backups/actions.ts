"use server";

import { revalidatePath } from "next/cache";
import { serverTRPC } from "@/lib/trpc-server";

export type BackupNowResult =
  | { ok: true; dir: string; files: number; synced: boolean }
  | { ok: false; error: string };

export async function backupNowAction(): Promise<BackupNowResult> {
  try {
    const r = await serverTRPC.backup.createNow.mutate();
    revalidatePath("/backups");
    return { ok: true, dir: r.dir, files: r.files, synced: r.synced };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

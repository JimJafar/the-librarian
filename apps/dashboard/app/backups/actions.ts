"use server";

import { revalidatePath } from "next/cache";
import { serverTRPC } from "@/lib/trpc-server";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type BackupNowResult =
  | { ok: true; commit: string | null; repo: string }
  | { ok: false; error: string };

export async function backupNowAction(): Promise<BackupNowResult> {
  try {
    const r = await serverTRPC.backup.createNow.mutate();
    revalidatePath("/backups");
    return { ok: true, commit: r.commit, repo: r.repo };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// The setConfig input shape (mirrors the backup tRPC SetConfigSchema). The token is
// write-only: an empty/absent field leaves the stored value unchanged.
export interface SaveBackupConfigInput {
  enabled?: boolean;
  intervalMinutes?: number;
  webhookUrl?: string;
  github?: { repo?: string; token?: string };
}

export type SaveConfigResult = { ok: true } | { ok: false; error: string };

export async function saveBackupConfigAction(
  input: SaveBackupConfigInput,
): Promise<SaveConfigResult> {
  try {
    await serverTRPC.backup.setConfig.mutate(input);
    revalidatePath("/backups");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

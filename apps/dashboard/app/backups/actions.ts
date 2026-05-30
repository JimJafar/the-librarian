"use server";

import { revalidatePath } from "next/cache";
import { serverTRPC } from "@/lib/trpc-server";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type BackupNowResult =
  | { ok: true; files: number; synced: boolean; pruned: number }
  | { ok: false; error: string };

export async function backupNowAction(): Promise<BackupNowResult> {
  try {
    const r = await serverTRPC.backup.createNow.mutate();
    revalidatePath("/backups");
    return { ok: true, files: r.files, synced: r.synced, pruned: r.pruned };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// The setConfig input shape (mirrors the backup tRPC SetConfigSchema). Secrets are
// write-only: an empty/absent field leaves the stored value unchanged.
export interface SaveBackupConfigInput {
  enabled?: boolean;
  intervalMinutes?: number;
  target?: "local" | "s3" | "github";
  retentionKeep?: number;
  webhookUrl?: string;
  s3?: {
    bucket?: string;
    region?: string;
    endpoint?: string;
    prefix?: string;
    accessKey?: string;
    secretKey?: string;
  };
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

export type StageRestoreResult = { ok: true; staged: string } | { ok: false; error: string };

export async function stageRestoreAction(bundle: string): Promise<StageRestoreResult> {
  try {
    const r = await serverTRPC.backup.stageRestore.mutate({ bundle });
    revalidatePath("/backups");
    return { ok: true, staged: r.staged };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

export type RestartResult = { ok: true } | { ok: false; error: string };

export async function restartAction(): Promise<RestartResult> {
  try {
    await serverTRPC.backup.restart.mutate();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

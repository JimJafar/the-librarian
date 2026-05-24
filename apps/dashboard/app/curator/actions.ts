"use server";

import type { CuratorConfigPatch, CuratorTickResult } from "@librarian/core";
import { revalidatePath } from "next/cache";
import { serverTRPC } from "@/lib/trpc-server";

export type RunNowResult = { ok: true; result: CuratorTickResult } | { ok: false; error: string };

export type SaveConfigResult = { ok: true } | { ok: false; error: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Admin run-now (§12) — shares the scheduler enqueue path via the curator router.
export async function runCuratorNowAction(): Promise<RunNowResult> {
  try {
    const result = await serverTRPC.curator.runNow.mutate();
    revalidatePath("/curator");
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// Save the curator config (§7.1). An empty token field leaves the stored token
// unchanged (the form never round-trips the secret); send "" explicitly to clear.
export async function saveCuratorConfigAction(
  patch: CuratorConfigPatch,
): Promise<SaveConfigResult> {
  try {
    await serverTRPC.curator.setConfig.mutate(patch);
    revalidatePath("/curator");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

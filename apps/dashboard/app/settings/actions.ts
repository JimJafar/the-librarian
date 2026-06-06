"use server";

import { revalidatePath } from "next/cache";
import { serverTRPC } from "@/lib/trpc-server";

// Server actions for the settings home (spec 041 PR-1 / Task A1). The awareness
// primer is a server-sourced note injected on every harness turn; saving "" (an
// empty textarea) disables it. Mirrors the curator config-action shape
// (server action → tRPC → revalidatePath).

export type SavePrimerResult = { ok: true } | { ok: false; error: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function saveAwarenessPrimerAction(primer: string): Promise<SavePrimerResult> {
  try {
    await serverTRPC.awareness.setPrimer.mutate({ primer });
    revalidatePath("/settings");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

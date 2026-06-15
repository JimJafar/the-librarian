"use server";

import { revalidatePath } from "next/cache";
import { serverTRPC } from "@/lib/trpc-server";

// Server actions for the settings home (spec 041 A1, repointed by rethink
// T11). The primer lives at vault/primer.md and is delivered when an agent
// connects (MCP initialize `instructions` + GET /primer.md); saving "" (an
// empty textarea) disables it, and an over-2KB save is refused server-side
// (the teaching message comes back as the error). Mirrors the curator
// config-action shape (server action → tRPC → revalidatePath).

export type SavePrimerResult = { ok: true } | { ok: false; error: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function saveAwarenessPrimerAction(primer: string): Promise<SavePrimerResult> {
  try {
    await serverTRPC.awareness.setPrimer.mutate({ primer });
    revalidatePath("/settings/primer");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

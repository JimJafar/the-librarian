"use server";

import { revalidatePath } from "next/cache";
import { serverTRPC } from "@/lib/trpc-server";

export type DomainsActionResult = { ok: true } | { ok: false; error: string };

function fail(message: string): DomainsActionResult {
  return { ok: false, error: message };
}

function string(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function addDomainAction(form: FormData): Promise<DomainsActionResult> {
  try {
    const name = string(form, "name");
    if (!name) return fail("Domain name is required.");
    await serverTRPC.domains.add.mutate({ name });
    revalidatePath("/domains");
    return { ok: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function removeDomainAction(name: string): Promise<DomainsActionResult> {
  try {
    await serverTRPC.domains.remove.mutate({ name });
    revalidatePath("/domains");
    return { ok: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

"use server";

import { revalidatePath } from "next/cache";
import {
  CATEGORIES,
  SCOPES,
  VISIBILITIES,
  type Category,
  type RouterInputs,
  type Scope,
  type Visibility,
} from "@/components/memories/types";
import { serverTRPC } from "@/lib/trpc-server";

type CreateInput = NonNullable<RouterInputs["memories"]["create"]>;
type UpdatePatch = RouterInputs["memories"]["update"]["patch"];

type ActionResult = { ok: true } | { ok: false; error: string };

function fail(message: string): ActionResult {
  return { ok: false, error: message };
}

function string(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function tags(form: FormData, key: string): string[] {
  const raw = form.get(key);
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function category(form: FormData): Category | undefined {
  const v = string(form, "category");
  return v && (CATEGORIES as readonly string[]).includes(v) ? (v as Category) : undefined;
}

function visibility(form: FormData): Visibility | undefined {
  const v = string(form, "visibility");
  return v && (VISIBILITIES as readonly string[]).includes(v) ? (v as Visibility) : undefined;
}

function scope(form: FormData): Scope | undefined {
  const v = string(form, "scope");
  return v && (SCOPES as readonly string[]).includes(v) ? (v as Scope) : undefined;
}

export async function createMemoryAction(form: FormData): Promise<ActionResult> {
  try {
    const input = {
      title: string(form, "title"),
      body: string(form, "body"),
      category: category(form),
      visibility: visibility(form),
      scope: scope(form),
      tags: tags(form, "tags"),
    } as CreateInput;
    await serverTRPC.memories.create.mutate(input);
    revalidatePath("/memories");
    return { ok: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function updateMemoryAction(id: string, form: FormData): Promise<ActionResult> {
  try {
    const patch = {
      title: string(form, "title"),
      body: string(form, "body"),
      category: category(form),
      visibility: visibility(form),
      scope: scope(form),
      tags: tags(form, "tags"),
    } as UpdatePatch;
    await serverTRPC.memories.update.mutate({ id, patch });
    revalidatePath("/memories");
    return { ok: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function deleteMemoryAction(id: string): Promise<ActionResult> {
  try {
    await serverTRPC.memories.delete.mutate({ id });
    revalidatePath("/memories");
    return { ok: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function recallAction(query: string): Promise<ActionResult & { count?: number }> {
  if (!query.trim()) return fail("Recall query is empty.");
  try {
    const result = await serverTRPC.memories.recall.mutate({ query, limit: 12 });
    revalidatePath("/memories");
    return { ok: true, count: result.memories.length };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

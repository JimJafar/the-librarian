"use server";

import { revalidatePath } from "next/cache";
import {
  CATEGORIES,
  SCOPES,
  VISIBILITIES,
  type Category,
  type MemoryRow,
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
    revalidatePath("/");
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
    revalidatePath("/");
    return { ok: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

function revalidateMemoryRoutes(): void {
  // Approve/reject can move a row between the active list, the proposals
  // queue, conflicts, and archive — revalidate all the views that read
  // status-filtered memories so a navigation back doesn't show stale rows.
  revalidatePath("/");
  revalidatePath("/proposals");
  revalidatePath("/conflicts");
  revalidatePath("/archive");
}

export async function approveProposalAction(id: string): Promise<ActionResult> {
  try {
    await serverTRPC.memories.approve.mutate({ id });
    revalidateMemoryRoutes();
    return { ok: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function rejectProposalAction(id: string): Promise<ActionResult> {
  try {
    await serverTRPC.memories.reject.mutate({ id });
    revalidateMemoryRoutes();
    return { ok: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function deleteMemoryAction(id: string): Promise<ActionResult> {
  try {
    await serverTRPC.memories.delete.mutate({ id });
    revalidatePath("/");
    return { ok: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export type RecallResult = { ok: true; memories: MemoryRow[] } | { ok: false; error: string };

export async function recallAction(query: string): Promise<RecallResult> {
  if (!query.trim()) return { ok: false, error: "Recall query is empty." };
  try {
    const result = await serverTRPC.memories.recall.mutate({ query, limit: 12 });
    revalidatePath("/");
    return { ok: true, memories: result.memories as MemoryRow[] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

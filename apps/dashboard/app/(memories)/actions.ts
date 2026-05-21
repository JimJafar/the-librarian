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
  // queue, and the archive — revalidate every status-filtered view so a
  // navigation back doesn't show stale rows.
  revalidatePath("/");
  revalidatePath("/proposals");
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

export async function archiveMemoryAction(id: string): Promise<ActionResult> {
  try {
    await serverTRPC.memories.archive.mutate({ id });
    revalidatePath("/");
    revalidatePath("/archive");
    return { ok: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export type BulkUpdateResult =
  | { ok: true; updated: number; transaction_id: string }
  | { ok: false; error: string };

// D1.1 — re-home flow: bulk-update memories' agent_id and/or project_key
// in one tRPC round-trip. Whitelisted server-side to those two fields.
export async function bulkUpdateMemoriesAction(
  ids: string[],
  patch: { agent_id?: string; project_key?: string },
): Promise<BulkUpdateResult> {
  if (ids.length === 0) return { ok: false, error: "No memories selected." };
  if (patch.agent_id === undefined && patch.project_key === undefined) {
    return { ok: false, error: "Re-home requires a new agent or project." };
  }
  try {
    const cleanPatch: { agent_id?: string; project_key?: string } = {};
    if (patch.agent_id !== undefined) cleanPatch.agent_id = patch.agent_id;
    if (patch.project_key !== undefined) cleanPatch.project_key = patch.project_key;
    const result = await serverTRPC.memories.bulkUpdate.mutate({ ids, patch: cleanPatch });
    revalidatePath("/");
    return { ok: true, updated: result.updated, transaction_id: result.transaction_id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
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

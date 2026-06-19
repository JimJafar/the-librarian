"use server";

import { revalidatePath } from "next/cache";
import { type MemoryRow, type ReferenceHit, type RouterInputs } from "@/components/memories/types";
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

export async function createMemoryAction(form: FormData): Promise<ActionResult> {
  try {
    const input = {
      title: string(form, "title"),
      body: string(form, "body"),
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

// Adjudicate one flagged memory (spec 048 PR-2) via tRPC `memories.resolveFlag`.
// `dismiss` clears the open flags and keeps the memory active; `archive`
// archives it then clears its flags — either way the row drops out of the
// flagged review queue. Revalidates the flagged + active + archive views so a
// navigation back doesn't show a stale queue.
export async function resolveFlagAction(
  id: string,
  action: "dismiss" | "archive",
): Promise<ActionResult> {
  try {
    await serverTRPC.memories.resolveFlag.mutate({ id, action });
    revalidatePath("/");
    revalidatePath("/flagged");
    revalidatePath("/archive");
    return { ok: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export type BulkUpdateResult =
  | { ok: true; updated: number; transaction_id: string }
  | { ok: false; error: string };

// D1.1 — re-home flow: bulk-update memories' agent_id in one tRPC round-trip.
// Whitelisted server-side to agent_id (memories are project-less now).
export async function bulkUpdateMemoriesAction(
  ids: string[],
  patch: { agent_id?: string },
): Promise<BulkUpdateResult> {
  if (ids.length === 0) return { ok: false, error: "No memories selected." };
  if (patch.agent_id === undefined) {
    return { ok: false, error: "Re-home requires a new agent." };
  }
  try {
    const result = await serverTRPC.memories.bulkUpdate.mutate({
      ids,
      patch: { agent_id: patch.agent_id },
    });
    revalidatePath("/");
    return { ok: true, updated: result.updated, transaction_id: result.transaction_id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type PurgeResult = { ok: true; purged: number } | { ok: false; error: string };

// Permanently delete archived memories (irreversible from the app). Hard-deletes
// via tRPC `memories.purge`, which refuses any non-archived memory server-side.
// Revalidates the archive view so the deleted rows drop out.
export async function purgeMemoriesAction(ids: string[]): Promise<PurgeResult> {
  if (ids.length === 0) return { ok: false, error: "No memories selected." };
  try {
    const result = await serverTRPC.memories.purge.mutate({ ids });
    revalidatePath("/archive");
    return { ok: true, purged: result.purged };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type RecallResult = { ok: true; memories: MemoryRow[] } | { ok: false; error: string };

// Recall via the hybrid engine (the server procedure calls store.recall). `tags`
// (any-match) and `limit` are the same knobs the recall MCP tool gives agents,
// so the operator can reproduce a specific agent's recall; both are omitted when
// absent so the default limit (12) applies.
export async function recallAction(
  query: string,
  opts?: { tags?: string[]; limit?: number },
): Promise<RecallResult> {
  if (!query.trim()) return { ok: false, error: "Recall query is empty." };
  try {
    const result = await serverTRPC.memories.recall.mutate({
      query,
      ...(opts?.tags && opts.tags.length > 0 ? { tags: opts.tags } : {}),
      limit: opts?.limit ?? 12,
    });
    revalidatePath("/");
    return { ok: true, memories: result.memories as MemoryRow[] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type SearchReferencesResult =
  | { ok: true; references: ReferenceHit[]; searched: number }
  | { ok: false; error: string };

// The References retrieval tester. Calls vault.searchReferences — the same store
// method the search_references MCP tool runs — so the operator sees exactly what
// an agent sees. `searched` (the count of reference docs in the vault) is passed
// through so the UI can tell "none filed" from "filed but none matched". `limit`
// is omitted when absent so the server applies its default (12); a pure read, so
// no revalidation.
export async function searchReferencesAction(
  query: string,
  limit?: number,
): Promise<SearchReferencesResult> {
  if (!query.trim()) return { ok: false, error: "Reference query is empty." };
  try {
    const result = await serverTRPC.vault.searchReferences.mutate({
      query,
      ...(limit !== undefined ? { limit } : {}),
    });
    return { ok: true, references: result.references, searched: result.searched };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Memory tRPC procedures.
//
// Typed read/write surface for the dashboard: list/get/recall/aggregates,
// create/update/delete memories, proposal approve/reject, and
// related-memory similarity. All procedures are admin-gated;
// dashboard callers authenticate with LIBRARIAN_ADMIN_TOKEN and the
// gate runs once in `adminProcedure`.
//
// Note on `as Record<string, unknown>` casts: the store APIs in
// @librarian/core (createMemory, listMemories, updateMemory, …) still
// accept loose record inputs because the JS-era surface hasn't been
// tightened yet. Tightening core's signatures is tracked as a Phase 4
// follow-up; the casts at this boundary are safe because the Zod input
// schemas validate before the cast runs.

import {
  DEFAULT_AGENT_ID,
  type SplitReplacement,
  SYSTEM_ACTOR_IDS,
  mergeMemory,
  splitMemory,
} from "@librarian/core";
import {
  MemoryInputSchema,
  MemoryPatchSchema,
  MemoryStatusSchema,
  VisibilitySchema,
} from "@librarian/core/schemas";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

// `MemoryShape` mirrors `Memory` from `@librarian/core/store-internal`
// without re-using the exported name. Inlining keeps the inferred
// `memoriesRouter` / `appRouter` types portable — after sessions-rethink
// PR 7 narrowed `LibrarianStore`, the only path TS could find for `Memory`
// was the deep `@librarian/core/dist/store/memory-store.js` import, which
// fires TS2742. Casting every store result through this local shape keeps
// the named type out of the inferred chain.
export interface MemoryShape {
  id: string;
  agent_id: string;
  category?: string;
  visibility?: string;
  scope?: string;
  status: string;
  tags: string[];
  applies_to: string[];
  supersedes: string[];
  conflicts_with: string[];
  recall_count: number;
  usefulness_score: number;
  title: string;
  body: string;
  priority: string;
  confidence: string;
  project_key?: string | null;
  updated_at: string;
  curator_note?: Record<string, unknown> | null;
  is_global: boolean;
  requires_approval: boolean;
  [key: string]: unknown;
}

// Admin dashboard mutations record the reserved `dashboard-admin` actor (§6/§7.5).
const DASHBOARD_AGENT_ID = SYSTEM_ACTOR_IDS.dashboardAdmin;
const RECALL_DEFAULT_LIMIT = 12;

const SortFieldSchema = z.enum(["created_at", "updated_at", "title", "priority"]);
const SortOrderSchema = z.enum(["asc", "desc"]);

const ListMemoriesInputSchema = z.object({
  status: MemoryStatusSchema.optional(),
  agent_id: z.string().optional(),
  project_key: z.string().optional(),
  // Section 4d.2 — category/scope are opaque strings now; visibility
  // still validates against the enum because sessions use it.
  category: z.string().optional(),
  visibility: VisibilitySchema.optional(),
  scope: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  sort: SortFieldSchema.optional(),
  order: SortOrderSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().nonnegative().optional(),
});

const IdInputSchema = z.object({ id: z.string().min(1) });

const UpdateMemoryInputSchema = z.object({
  id: z.string().min(1),
  patch: MemoryPatchSchema,
  agent_id: z.string().optional(),
});

const ArchiveMemoryInputSchema = z.object({
  id: z.string().min(1),
  agent_id: z.string().optional(),
});

// D1.1 — bulk-update + distinctValues input shapes for the dashboard's
// re-home flow and data-driven filter dropdowns.
const BulkUpdateMemoryInputSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(500),
  patch: z
    .object({
      agent_id: z.string().min(1).optional(),
      project_key: z.string().min(1).optional(),
    })
    .refine(
      (p) => p.agent_id !== undefined || p.project_key !== undefined,
      "patch must contain at least one of agent_id or project_key",
    ),
  agent_id: z.string().optional(),
});

// Permanent delete (irreversible from the app): hard-delete ARCHIVED memories.
const PurgeMemoriesInputSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(500),
  agent_id: z.string().optional(),
});

const DistinctValuesFieldSchema = z.enum(["agent_id", "project_key", "category", "visibility"]);
const DistinctValuesInputSchema = z.object({
  field: DistinctValuesFieldSchema,
  include_archived: z.boolean().optional(),
});

// Admin mutation primitives (spec 044 D-5a). merge/split let an admin fix the
// corpus OUTSIDE a curation run, calling the SAME shared store primitives
// (mergeMemory / splitMemory) the curator run path uses. The replacement(s) carry
// the curator's MemoryInput shape (title/body/category/…); ownership + provenance
// are stamped server-side, never taken from the request.
const MergeMemoryInputSchema = z.object({
  // ≥2 sources — merging fewer than two is a no-op/rename, not a merge.
  source_ids: z.array(z.string().min(1)).min(2),
  replacement: MemoryInputSchema,
  agent_id: z.string().optional(),
});

const SplitMemoryInputSchema = z.object({
  source_id: z.string().min(1),
  // ≥2 replacements — splitting into one is a no-op/rename, not a split.
  replacements: z.array(MemoryInputSchema).min(2),
  agent_id: z.string().optional(),
});

// unmerge (spec 044 D-5b) — `id` is the MERGED target whose merge to reverse.
const UnmergeMemoryInputSchema = z.object({
  id: z.string().min(1),
  agent_id: z.string().optional(),
});

const ApproveProposalInputSchema = z.object({
  id: z.string().min(1),
  patch: MemoryPatchSchema.optional(),
  agent_id: z.string().optional(),
});

const RejectProposalInputSchema = z.object({
  id: z.string().min(1),
  agent_id: z.string().optional(),
});

const RecallInputSchema = z.object({
  agent_id: z.string().optional(),
  query: z.string().optional(),
  categories: z.array(z.string()).optional(),
  project_key: z.string().optional(),
  include_private: z.boolean().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

// The store throws plain Error with this prefix when a row is missing.
// We rewrap into a tRPC NOT_FOUND so admin callers see the right HTTP
// status. Any other error propagates as INTERNAL_SERVER_ERROR.
function rethrowAsNotFound<T>(fn: () => T, message: string): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof Error && /No memory found/i.test(error.message)) {
      throw new TRPCError({ code: "NOT_FOUND", message });
    }
    throw error;
  }
}

// Build the createMemory `{ input, options }` for one memory an admin merge/split
// writes (spec 044 D-5a) — the admin analogue of curator-apply.ts's
// `buildCreateCall`. Owner + curator_note (provenance source="admin-chat" +
// supersedes) are stamped server-side. The note's `source` key marks these as
// admin-initiated (not a curation run); `supersedes` records what the new memory
// replaces, so the corpus's provenance graph stays intact.
function adminCreateCall(
  memory: Record<string, unknown>,
  supersedes: string[],
  owner: string,
): SplitReplacement {
  const curatorNote: Record<string, unknown> = { source: "admin-chat" };
  if (supersedes.length > 0) curatorNote.supersedes = supersedes;
  return { input: { ...memory, agent_id: owner }, options: { curator_note: curatorNote } };
}

export const memoriesRouter = router({
  list: adminProcedure.input(ListMemoriesInputSchema.optional()).query(
    ({ ctx, input }) =>
      ctx.store.listMemories((input ?? {}) as Record<string, unknown>) as {
        memories: MemoryShape[];
        total: number;
      },
  ),

  aggregates: adminProcedure.query(({ ctx }) => ctx.store.getAggregates()),

  related: adminProcedure.input(IdInputSchema).query(({ ctx, input }) => {
    const result = ctx.store.getRelated(input.id);
    if (!result) throw new TRPCError({ code: "NOT_FOUND", message: "Memory not found" });
    return result as unknown as {
      memory: MemoryShape;
      related: { memory: MemoryShape; ratio: number; isDuplicate: boolean }[];
    };
  }),

  create: adminProcedure.input(MemoryInputSchema).mutation(
    ({ ctx, input }) =>
      ctx.store.createMemory(input as Record<string, unknown>) as unknown as {
        status: string;
        memory: MemoryShape;
        duplicates: MemoryShape[];
      },
  ),

  update: adminProcedure
    .input(UpdateMemoryInputSchema)
    .mutation(
      ({ ctx, input }) =>
        rethrowAsNotFound(
          () =>
            ctx.store.updateMemory(
              input.id,
              input.patch as Record<string, unknown>,
              input.agent_id ?? DASHBOARD_AGENT_ID,
              { allowProtected: true },
            ),
          "Memory not found",
        ) as unknown as MemoryShape,
    ),

  archive: adminProcedure
    .input(ArchiveMemoryInputSchema)
    .mutation(
      ({ ctx, input }) =>
        rethrowAsNotFound(
          () => ctx.store.archiveMemory(input.id, input.agent_id ?? DASHBOARD_AGENT_ID),
          "Memory not found",
        ) as unknown as MemoryShape,
    ),

  // Admin merge (spec 044 D-5a): collapse N sources into one target OUTSIDE a
  // curation run. Calls the SAME shared `mergeMemory` primitive the curator run
  // path uses (curator-apply.ts) — create the merged target (superseding the
  // sources, tagged provenance source="admin-chat"), then archive every source.
  // Passing the actor archives the sources (an admin merge auto-applies — there's
  // no run to defer to). Each store mutation lands a git commit (revertable).
  merge: adminProcedure.input(MergeMemoryInputSchema).mutation(({ ctx, input }) => {
    const actor = input.agent_id ?? DASHBOARD_AGENT_ID;
    const id = rethrowAsNotFound(
      () =>
        mergeMemory(ctx.store, {
          replacement: adminCreateCall(input.replacement, input.source_ids, actor),
          sourceIds: input.source_ids,
          archiveActorId: actor,
        }),
      "Memory not found",
    );
    return ctx.store.getMemory(id) as unknown as MemoryShape;
  }),

  // Admin split (spec 044 D-5a): spin one source into N replacements OUTSIDE a
  // curation run. Calls the SAME shared `splitMemory` primitive the curator run
  // path uses — create every replacement (each superseding the source, tagged
  // source="admin-chat"), then archive the source. Returns the new ids.
  split: adminProcedure.input(SplitMemoryInputSchema).mutation(({ ctx, input }) => {
    const actor = input.agent_id ?? DASHBOARD_AGENT_ID;
    const ids = rethrowAsNotFound(
      () =>
        splitMemory(ctx.store, {
          sourceId: input.source_id,
          replacements: input.replacements.map((r) => adminCreateCall(r, [input.source_id], actor)),
          archiveActorId: actor,
        }),
      "Memory not found",
    );
    return { ids };
  }),

  // Admin unmerge / reverse-a-groom (spec 044 D-5b): undo a bad merge. Given the
  // MERGED target's id, read its `curator_note.supersedes` (the source ids the
  // merge collapsed), un-archive every source (restore to active), then archive
  // the merged target. The ordering is data-loss-safe: sources are RESTORED
  // BEFORE the target is archived, so a partial failure can never leave the whole
  // group archived. A memory with no superseded sources is not a merge result —
  // we error rather than silently archive it (which would just lose the row).
  // Each transition lands a git commit (revertable). The provenance of these
  // status transitions is the `dashboard-admin` actor + the commit (curator_note
  // is not patchable in place — same invariant D-5a documented for archive).
  unmerge: adminProcedure.input(UnmergeMemoryInputSchema).mutation(({ ctx, input }) => {
    const actor = input.agent_id ?? DASHBOARD_AGENT_ID;
    const target = rethrowAsNotFound(() => {
      const found = ctx.store.getMemory(input.id);
      if (!found) throw new Error(`No memory found for id ${input.id}`);
      return found;
    }, "Memory not found") as unknown as MemoryShape;

    const note = (target.curator_note ?? {}) as Record<string, unknown>;
    const rawSupersedes = note.supersedes;
    const supersedes = Array.isArray(rawSupersedes)
      ? rawSupersedes.filter((s): s is string => typeof s === "string" && s.length > 0)
      : [];
    if (supersedes.length === 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Memory ${input.id} is not a merge result — it has no superseded sources to restore.`,
      });
    }

    // Data-loss-safe ordering: restore every source FIRST, then archive the target.
    for (const sourceId of supersedes) {
      rethrowAsNotFound(
        () => ctx.store.unarchiveMemory(sourceId, actor),
        `Superseded source ${sourceId} not found`,
      );
    }
    ctx.store.archiveMemory(input.id, actor);
    return { restored: supersedes, archived: input.id };
  }),

  bulkUpdate: adminProcedure.input(BulkUpdateMemoryInputSchema).mutation(({ ctx, input }) => {
    const patch: { agent_id?: string; project_key?: string } = {};
    if (input.patch.agent_id !== undefined) patch.agent_id = input.patch.agent_id;
    if (input.patch.project_key !== undefined) patch.project_key = input.patch.project_key;
    return ctx.store.bulkUpdateMemory({
      ids: input.ids,
      patch,
      agent_id: input.agent_id ?? DASHBOARD_AGENT_ID,
    });
  }),

  // Permanent delete (irreversible from the app). Hard-deletes ARCHIVED memories
  // via store.purgeMemory, which refuses any non-archived memory — so the archive
  // page's bulk delete can never destroy a live memory. Each purge is a git
  // commit (recoverable from history). Returns how many rows were removed; an
  // absent id is a no-op, so a re-run is safe.
  purge: adminProcedure.input(PurgeMemoriesInputSchema).mutation(({ ctx, input }) => {
    const actor = input.agent_id ?? DASHBOARD_AGENT_ID;
    let purged = 0;
    for (const id of input.ids) {
      if (ctx.store.purgeMemory(id, actor)) purged++;
    }
    return { purged };
  }),

  distinctValues: adminProcedure.input(DistinctValuesInputSchema).query(({ ctx, input }) => {
    const args: { field: string; include_archived?: boolean } = { field: input.field };
    if (input.include_archived !== undefined) args.include_archived = input.include_archived;
    return ctx.store.distinctValues(args);
  }),

  approve: adminProcedure
    .input(ApproveProposalInputSchema)
    .mutation(
      ({ ctx, input }) =>
        rethrowAsNotFound(
          () =>
            ctx.store.approveProposal(
              input.id,
              "approve",
              (input.patch ?? {}) as Record<string, unknown>,
              input.agent_id ?? DASHBOARD_AGENT_ID,
            ),
          "Proposal not found",
        ) as unknown as MemoryShape,
    ),

  reject: adminProcedure
    .input(RejectProposalInputSchema)
    .mutation(
      ({ ctx, input }) =>
        rethrowAsNotFound(
          () =>
            ctx.store.approveProposal(input.id, "reject", {}, input.agent_id ?? DASHBOARD_AGENT_ID),
          "Proposal not found",
        ) as unknown as MemoryShape,
    ),

  recall: adminProcedure.input(RecallInputSchema.optional()).mutation(({ ctx, input }) => {
    const agentId = input?.agent_id ?? DEFAULT_AGENT_ID;
    const query = input?.query ?? "";
    const memories = ctx.store.searchMemories({
      agent_id: agentId,
      query,
      categories: input?.categories ?? [],
      project_key: input?.project_key ?? "",
      include_private: input?.include_private ?? true,
      limit: input?.limit ?? RECALL_DEFAULT_LIMIT,
    });
    ctx.store.recordRecall(memories, agentId, query);
    return { memories: memories as MemoryShape[] };
  }),
});

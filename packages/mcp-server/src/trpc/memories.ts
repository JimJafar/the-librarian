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

import { DEFAULT_AGENT_ID, SYSTEM_ACTOR_IDS } from "@librarian/core";
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

const DistinctValuesFieldSchema = z.enum(["agent_id", "project_key", "category", "visibility"]);
const DistinctValuesInputSchema = z.object({
  field: DistinctValuesFieldSchema,
  include_archived: z.boolean().optional(),
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

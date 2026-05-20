// Memory tRPC procedures (T4.4).
//
// Mirrors the legacy /api/memories*, /api/proposals*, /api/events,
// /api/aggregates, /api/recall, and /api/memories/:id/related REST
// endpoints with typed Zod inputs. The old REST routes stay live and
// are deleted in T7.1; until then the dashboard can migrate
// procedure-by-procedure.
//
// All procedures are admin-gated. Dashboard callers authenticate with
// LIBRARIAN_ADMIN_TOKEN; the gate runs once in `adminProcedure`.

import {
  CategorySchema,
  MemoryInputSchema,
  MemoryPatchSchema,
  MemoryStatusSchema,
  ScopeSchema,
  VisibilitySchema,
} from "@librarian/core/schemas";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

const DASHBOARD_AGENT_ID = "dashboard";

const SortFieldSchema = z.enum(["created_at", "updated_at", "title", "priority"]);
const SortOrderSchema = z.enum(["asc", "desc"]);

const ListMemoriesInputSchema = z.object({
  status: MemoryStatusSchema.optional(),
  agent_id: z.string().optional(),
  project_key: z.string().optional(),
  category: CategorySchema.optional(),
  visibility: VisibilitySchema.optional(),
  scope: ScopeSchema.optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  sort: SortFieldSchema.optional(),
  order: SortOrderSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().nonnegative().optional(),
});

const ListEventsInputSchema = z.object({
  type: z.string().optional(),
  agent_id: z.string().optional(),
  memory_id: z.string().optional(),
  result: z.string().optional(),
  query: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().nonnegative().optional(),
});

const IdInputSchema = z.object({ id: z.string().min(1) });

const UpdateMemoryInputSchema = z.object({
  id: z.string().min(1),
  patch: MemoryPatchSchema,
  agent_id: z.string().optional(),
});

const DeleteMemoryInputSchema = z.object({
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

export const memoriesRouter = router({
  list: adminProcedure
    .input(ListMemoriesInputSchema.optional())
    .query(({ ctx, input }) => ctx.store.listMemories((input ?? {}) as Record<string, unknown>)),

  aggregates: adminProcedure.query(({ ctx }) => ctx.store.getAggregates()),

  events: adminProcedure
    .input(ListEventsInputSchema.optional())
    .query(({ ctx, input }) => ctx.store.listEvents((input ?? {}) as Record<string, unknown>)),

  related: adminProcedure.input(IdInputSchema).query(({ ctx, input }) => {
    const result = ctx.store.getRelated(input.id);
    if (!result) throw new TRPCError({ code: "NOT_FOUND", message: "Memory not found" });
    return result;
  }),

  create: adminProcedure
    .input(MemoryInputSchema)
    .mutation(({ ctx, input }) => ctx.store.createMemory(input as Record<string, unknown>)),

  update: adminProcedure.input(UpdateMemoryInputSchema).mutation(({ ctx, input }) => {
    const result = ctx.store.updateMemory(
      input.id,
      input.patch as Record<string, unknown>,
      input.agent_id ?? DASHBOARD_AGENT_ID,
      { allowProtected: true },
    );
    if (!result) throw new TRPCError({ code: "NOT_FOUND", message: "Memory not found" });
    return result;
  }),

  delete: adminProcedure.input(DeleteMemoryInputSchema).mutation(({ ctx, input }) => {
    const result = ctx.store.deleteMemory(input.id, input.agent_id ?? DASHBOARD_AGENT_ID);
    if (!result) throw new TRPCError({ code: "NOT_FOUND", message: "Memory not found" });
    return result;
  }),

  approve: adminProcedure.input(ApproveProposalInputSchema).mutation(({ ctx, input }) => {
    const result = ctx.store.approveProposal(
      input.id,
      "approve",
      (input.patch ?? {}) as Record<string, unknown>,
      input.agent_id ?? DASHBOARD_AGENT_ID,
    );
    if (!result) throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found" });
    return result;
  }),

  reject: adminProcedure.input(RejectProposalInputSchema).mutation(({ ctx, input }) => {
    const result = ctx.store.approveProposal(
      input.id,
      "reject",
      {},
      input.agent_id ?? DASHBOARD_AGENT_ID,
    );
    if (!result) throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found" });
    return result;
  }),

  recall: adminProcedure.input(RecallInputSchema.optional()).mutation(({ ctx, input }) => {
    const params = (input ?? {}) as Record<string, unknown>;
    const memories = ctx.store.searchMemories(params);
    ctx.store.recordRecall(
      memories,
      (params.agent_id as string | undefined) ?? undefined,
      (params.query as string | undefined) ?? "",
    );
    return { memories };
  }),
});

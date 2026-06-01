// Handoff tRPC procedures (sessions-rethink spec §6.7).
//
// Read-only dashboard surface — claim is an agent-only operation via the
// MCP layer. The dashboard renders the markdown document + metadata; admin
// purge belongs to a separate admin-only procedure once it's needed (not
// in v1, per spec §6.6 "Batch purge is YAGNI for v1").

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

const ListInputSchema = z.object({
  project_key: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
  harness: z.string().nullable().optional(),
  include_claimed: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const ByIdInputSchema = z.object({
  handoff_id: z.string().min(1),
});

export const handoffsRouter = router({
  list: adminProcedure.input(ListInputSchema.optional()).query(({ ctx, input }) => {
    const { include_claimed, limit, project_key, cwd, harness } = input ?? {};
    const details = ctx.store.handoffs.listDetails(
      { project_key, cwd, harness, limit: limit ?? 50 },
      { includeClaimed: include_claimed ?? false },
    );
    return details.map((d) => ({
      handoff_id: d.handoff_id,
      title: d.title,
      project_key: d.project_key,
      source_ref: d.source_ref,
      cwd: d.cwd,
      created_by_agent_id: d.created_by_agent_id,
      created_in_harness: d.created_in_harness,
      tags: d.tags,
      created_at: d.created_at,
      claimed_at: d.claimed_at,
      claimed_by: d.claimed_by,
    }));
  }),

  byId: adminProcedure.input(ByIdInputSchema).query(({ ctx, input }) => {
    const detail = ctx.store.handoffs.getById(input.handoff_id);
    if (!detail) throw new TRPCError({ code: "NOT_FOUND", message: "Handoff not found" });
    return detail;
  }),
});

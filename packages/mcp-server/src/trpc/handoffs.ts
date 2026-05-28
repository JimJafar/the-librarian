// Handoff tRPC procedures (sessions-rethink spec §6.7).
//
// Read-only dashboard surface — claim is an agent-only operation via the
// MCP layer. The dashboard renders the markdown document + metadata; admin
// purge belongs to a separate admin-only procedure once it's needed (not
// in v1, per spec §6.6 "Batch purge is YAGNI for v1").

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

const DEFAULT_DOMAIN = "general";

const ListInputSchema = z.object({
  project_key: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
  harness: z.string().nullable().optional(),
  domain: z.string().optional(),
  include_claimed: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const ByIdInputSchema = z.object({
  handoff_id: z.string().min(1),
});

interface HandoffDetailRow {
  id: string;
  title: string;
  document_md: string;
  project_key: string | null;
  source_ref: string | null;
  cwd: string | null;
  domain: string;
  created_by_agent_id: string | null;
  created_in_harness: string | null;
  tags_json: string;
  created_at: string;
  claimed_at: string | null;
  claimed_by_json: string | null;
}

function parseTags(json: string): string[] {
  try {
    const parsed = JSON.parse(json || "[]");
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function parseClaimedBy(json: string | null) {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export const handoffsRouter = router({
  list: adminProcedure.input(ListInputSchema.optional()).query(({ ctx, input }) => {
    const {
      domain = DEFAULT_DOMAIN,
      include_claimed,
      limit,
      project_key,
      cwd,
      harness,
    } = input ?? {};
    const where: string[] = ["domain = ?"];
    const params: (string | number)[] = [domain];
    if (!include_claimed) where.push("claimed_at IS NULL");
    if (project_key != null) {
      where.push("project_key = ?");
      params.push(project_key);
    }
    if (cwd != null) {
      where.push("cwd = ?");
      params.push(cwd);
    }
    if (harness != null) {
      where.push("created_in_harness = ?");
      params.push(harness);
    }
    params.push(limit ?? 50);
    const rows = ctx.store.db
      .prepare(
        `SELECT * FROM handoffs WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...params) as unknown as HandoffDetailRow[];
    return rows.map((row) => ({
      handoff_id: row.id,
      title: row.title,
      project_key: row.project_key,
      source_ref: row.source_ref,
      cwd: row.cwd,
      domain: row.domain,
      created_by_agent_id: row.created_by_agent_id,
      created_in_harness: row.created_in_harness,
      tags: parseTags(row.tags_json),
      created_at: row.created_at,
      claimed_at: row.claimed_at,
      claimed_by: parseClaimedBy(row.claimed_by_json),
    }));
  }),

  byId: adminProcedure.input(ByIdInputSchema).query(({ ctx, input }) => {
    const row = ctx.store.db
      .prepare("SELECT * FROM handoffs WHERE id = ?")
      .get(input.handoff_id) as HandoffDetailRow | undefined;
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Handoff not found" });
    return {
      handoff_id: row.id,
      title: row.title,
      document_md: row.document_md,
      project_key: row.project_key,
      source_ref: row.source_ref,
      cwd: row.cwd,
      domain: row.domain,
      created_by_agent_id: row.created_by_agent_id,
      created_in_harness: row.created_in_harness,
      tags: parseTags(row.tags_json),
      created_at: row.created_at,
      claimed_at: row.claimed_at,
      claimed_by: parseClaimedBy(row.claimed_by_json),
    };
  }),
});

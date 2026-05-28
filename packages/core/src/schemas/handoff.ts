// Handoff schemas (sessions-rethink spec §6.1).
//
// A handoff is a self-contained narrative the outgoing agent stores at the end
// of `/handoff`. The incoming `/takeover` claims it in a single atomic step,
// receives the document_md, and injects it into the new conversation. The
// document follows the §6.3 template — five anchored headings — and that
// template is enforced here at the Zod boundary so the store can trust input.

import { z } from "zod";
import { IdSchema, IsoTimestampSchema } from "./common.js";

// The five-section template (§6.3). The refinement asserts each heading
// appears exactly as written, anchored to the start of a line. A missing or
// renamed heading bounces the input at the MCP boundary, before it can reach
// the store.
const REQUIRED_HEADINGS = [
  "Start & intent",
  "Journey",
  "Current state",
  "What's left",
  "Open questions",
] as const;

function hasAllRequiredHeadings(document: string): boolean {
  return REQUIRED_HEADINGS.every((heading) => {
    // Anchored multiline regex per spec §6.1: each heading must appear as a
    // standalone `## <heading>` line. Escape the `&`/`'` shouldn't be needed
    // for regex (neither is a regex metachar) but we build the pattern from
    // the literal string to keep that decision data-driven.
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^## ${escaped}\\b`, "m");
    return pattern.test(document);
  });
}

export const StoreHandoffInputSchema = z
  .object({
    title: z.string().min(5).max(120),
    document_md: z.string().min(100).max(50000),
    project_key: z.string().nullable().optional(),
    source_ref: z.string().nullable().optional(),
    cwd: z.string().nullable().optional(),
    harness: z.string().nullable().optional(),
    tags: z.array(z.string()).max(10).optional(),
  })
  .refine((value) => hasAllRequiredHeadings(value.document_md), {
    message:
      "document_md must include each of the five required headings: " +
      REQUIRED_HEADINGS.map((h) => `'## ${h}'`).join(", "),
    path: ["document_md"],
  });
export type StoreHandoffInput = z.infer<typeof StoreHandoffInputSchema>;

export const StoreHandoffOutputSchema = z.object({
  handoff_id: IdSchema,
  created_at: IsoTimestampSchema,
});
export type StoreHandoffOutput = z.infer<typeof StoreHandoffOutputSchema>;

export const ListHandoffsInputSchema = z.object({
  project_key: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
  harness: z.string().nullable().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type ListHandoffsInput = z.infer<typeof ListHandoffsInputSchema>;

export const HandoffSummarySchema = z.object({
  handoff_id: IdSchema,
  title: z.string(),
  project_key: z.string().nullable(),
  source_ref: z.string().nullable(),
  cwd: z.string().nullable(),
  created_in_harness: z.string().nullable(),
  created_by_agent_id: z.string().nullable(),
  created_at: IsoTimestampSchema,
  tags: z.array(z.string()),
});
export type HandoffSummary = z.infer<typeof HandoffSummarySchema>;

export const ListHandoffsOutputSchema = z.object({
  handoffs: z.array(HandoffSummarySchema),
});
export type ListHandoffsOutput = z.infer<typeof ListHandoffsOutputSchema>;

export const ClaimHandoffInputSchema = z.object({
  handoff_id: IdSchema,
  claiming_agent_id: z.string().nullable().optional(),
  claiming_harness: z.string().nullable().optional(),
  claiming_source_ref: z.string().nullable().optional(),
  claiming_cwd: z.string().nullable().optional(),
});
export type ClaimHandoffInput = z.infer<typeof ClaimHandoffInputSchema>;

export const ClaimHandoffOutputSchema = z.object({
  handoff_id: IdSchema,
  title: z.string(),
  document_md: z.string(),
  created_by_agent_id: z.string().nullable(),
  created_in_harness: z.string().nullable(),
  created_at: IsoTimestampSchema,
  claimed_at: IsoTimestampSchema,
});
export type ClaimHandoffOutput = z.infer<typeof ClaimHandoffOutputSchema>;

export const HANDOFF_REQUIRED_HEADINGS: readonly string[] = REQUIRED_HEADINGS;

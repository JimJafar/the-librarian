// Consolidator — judge decision layer (spec 035 §F5: "judge (augment/create/
// supersede/archive), confidence band ≥0.95 auto / 0.85–0.95 proposal / ≤0.85
// new (S12)"). Two PURE pieces, both independent of the LLM:
//
//   1. parseConsolidationJudgment — the LLM's per-submission decision is
//      UNTRUSTED; parse the JSON and strictly validate it (strict objects reject
//      smuggled fields, mirroring parseCuratorOutput). One submission → one
//      judgment (not a batch like the curator).
//   2. routeConsolidation — map the judgment + its confidence to a routing
//      decision by the three bands, per action. The bands encode the safety
//      posture: a merge we're unsure of becomes a NEW doc rather than a wrong
//      merge (S12); a contradiction/removal we're unsure of goes to a human
//      proposal, never a silent auto-apply (S4 / no-clobber).
//
// The prompt + LLM call that produces the raw judgment is a separate increment;
// this layer is what consumes its output.

import { z } from "zod";

const rationale = z.string().min(1);
const confidence = z.number().min(0).max(1);

/** Novel fact with no good existing home → a fresh doc (S1). */
const CreateJudgment = z.strictObject({
  action: z.literal("create"),
  title: z.string().min(1),
  body: z.string().min(1),
  tags: z.array(z.string()).default([]),
  rationale,
  confidence,
});
/** Weave the new fact into an existing doc (S2/S18) — minimal-edit at apply time. */
const AugmentJudgment = z.strictObject({
  action: z.literal("augment"),
  target_id: z.string().min(1),
  addition: z.string().min(1),
  rationale,
  confidence,
});
/** The submission contradicts/updates an existing doc → replace it (S4). */
const SupersedeJudgment = z.strictObject({
  action: z.literal("supersede"),
  target_id: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  rationale,
  confidence,
});
/** An existing doc is now stale (no replacement). */
const ArchiveJudgment = z.strictObject({
  action: z.literal("archive"),
  target_id: z.string().min(1),
  rationale,
  confidence,
});
/** Nothing to do — a duplicate or non-actionable submission. */
const NoopJudgment = z.strictObject({
  action: z.literal("noop"),
  rationale,
  confidence,
});

export const ConsolidationJudgmentSchema = z.discriminatedUnion("action", [
  CreateJudgment,
  AugmentJudgment,
  SupersedeJudgment,
  ArchiveJudgment,
  NoopJudgment,
]);
export type ConsolidationJudgment = z.infer<typeof ConsolidationJudgmentSchema>;

export interface ParsedConsolidationJudgment {
  judgment?: ConsolidationJudgment;
  /** Set when the response was unusable (bad JSON or schema-invalid). */
  parseError?: string;
}

export function parseConsolidationJudgment(raw: string): ParsedConsolidationJudgment {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    return { parseError: "output was not valid JSON" };
  }
  const result = ConsolidationJudgmentSchema.safeParse(parsed);
  if (!result.success) return { parseError: summarizeIssues(result.error) };
  return { judgment: result.data };
}

/** auto_apply: do it now · propose: route to a human · create_new: file a fresh
 * doc instead of touching an existing one · skip: nothing to do. */
export type ConsolidationDecision = "auto_apply" | "propose" | "create_new" | "skip";

export interface ConsolidationThresholds {
  /** Confidence at/above which a judgment auto-applies (default 0.95). */
  autoApply: number;
  /** Confidence at/above which it routes to a proposal (default 0.85). */
  propose: number;
}

const DEFAULT_THRESHOLDS: ConsolidationThresholds = { autoApply: 0.95, propose: 0.85 };

export interface ConsolidationPlan {
  decision: ConsolidationDecision;
  judgment: ConsolidationJudgment;
}

export function routeConsolidation(
  judgment: ConsolidationJudgment,
  thresholds: ConsolidationThresholds = DEFAULT_THRESHOLDS,
): ConsolidationPlan {
  return { decision: decide(judgment, thresholds), judgment };
}

function decide(
  judgment: ConsolidationJudgment,
  t: ConsolidationThresholds,
): ConsolidationDecision {
  switch (judgment.action) {
    case "noop":
      return "skip";
    // A fresh doc puts no existing knowledge at risk, so it's the safe default —
    // auto-applied regardless of confidence (worst case is a near-duplicate that
    // later grooming merges, never a clobber).
    case "create":
      return "auto_apply";
    // Weaving into an existing doc: confident → apply; middle → human proposal;
    // uncertain → create a NEW doc rather than risk a wrong/under-merge (S12).
    case "augment":
      if (judgment.confidence >= t.autoApply) return "auto_apply";
      if (judgment.confidence >= t.propose) return "propose";
      return "create_new";
    // Replacing or removing existing knowledge: only a very confident judgment
    // auto-applies; anything less goes to a human, never a silent replace/remove
    // (S4 contradiction caution / no-clobber).
    case "supersede":
    case "archive":
      return judgment.confidence >= t.autoApply ? "auto_apply" : "propose";
  }
}

// Tolerate a single markdown code fence some providers wrap JSON in.
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/\n?```$/, "")
    .trim();
}

// Build the error from issue CODE + PATH only — never Zod's message text or the
// received value, which echo untrusted (possibly secret-looking) model output.
function summarizeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path.join(".");
      const detail = issue.code === "unrecognized_keys" ? "unexpected field" : issue.code;
      return path ? `${path}: ${detail}` : detail;
    })
    .join("; ");
}

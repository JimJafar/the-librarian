// Fixture schema for consolidator evaluation samples (plan 036 Phase 4 / the
// C6 checkpoint; scenarios from spec 035 §F5 + the brainstorm-mvp §9 list).
//
// Each entry is a SUBMISSION the consolidator must file, plus the existing
// memories it can see (the `corpus`), plus the GROUND-TRUTH outcome a correct
// consolidator should reach: the judge `action` and the routing `decision`
// (and, for a targeted action, which corpus doc it must touch). The harness
// runs every entry through navigate→judge→route and reports agreement against
// these expectations.
//
// `category: "straight"` is a clear case; `category: "boundary"` flags a case
// where the right answer needs judgement (ambiguous entity, contradiction,
// hand-authored prose that must not be clobbered). The harness can filter to
// boundary-only to surface the hard evaluations.
//
// The five scenarios:
//   S1  — new fact on a novel topic → create.
//   S2  — multi-entity fact (the "Anna problem") → augment the primary entity.
//   S4  — updated/conflicting fact → supersede, not blind augment.
//   S12 — ambiguous entity (two "Anna"s) → an uncertain merge must NOT silently
//         under-merge: route to create_new (low-confidence augment) or propose.
//   S18 — augmenting a hand-authored doc → never clobber the existing prose.

import { z } from "zod";

export const CONSOLIDATOR_SCENARIOS = ["S1", "S2", "S4", "S12", "S18"] as const;
export type ConsolidatorScenario = (typeof CONSOLIDATOR_SCENARIOS)[number];

/** A judge action (the discriminated-union actions of ConsolidationJudgment). */
export const JUDGE_ACTIONS = ["create", "augment", "supersede", "archive", "noop"] as const;
/** A routing decision (the bands `routeConsolidation` can emit). */
export const ROUTING_DECISIONS = ["auto_apply", "propose", "create_new", "skip"] as const;

// Which routing decisions each action can actually reach (mirrors
// `routeConsolidation` in @librarian/core). A fixture pairing an action with an
// unreachable decision is an authoring error — reject it at parse time.
const REACHABLE: Record<
  (typeof JUDGE_ACTIONS)[number],
  readonly (typeof ROUTING_DECISIONS)[number][]
> = {
  noop: ["skip"],
  create: ["auto_apply"],
  augment: ["auto_apply", "propose", "create_new"],
  supersede: ["auto_apply", "propose"],
  archive: ["auto_apply", "propose"],
};

const CorpusDocSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
  project_key: z.string().nullable().optional(),
});
export type ConsolidatorCorpusDoc = z.infer<typeof CorpusDocSchema>;

const ExpectedSchema = z.strictObject({
  action: z.enum(JUDGE_ACTIONS),
  decision: z.enum(ROUTING_DECISIONS),
  // Required for augment/supersede/archive — the corpus doc the judge must
  // touch. Validated to exist in the corpus by the cross-field refinement.
  target_id: z.string().min(1).optional(),
  // S18: when augmenting, the targeted doc's existing body must survive intact
  // (minimal-edit / no-clobber). The harness asserts `preservesOriginal`.
  preserves_corpus: z.boolean().optional(),
});

const SubmissionSchema = z.strictObject({
  text: z.string().min(1),
  hints: z
    .strictObject({
      agent_id: z.string().optional(),
      project_key: z.string().nullable().optional(),
      tags: z.array(z.string()).optional(),
    })
    .optional(),
});

export const ConsolidatorFixtureEntrySchema = z
  .strictObject({
    id: z.string().min(1),
    scenario: z.enum(CONSOLIDATOR_SCENARIOS),
    category: z.enum(["straight", "boundary"]),
    submission: SubmissionSchema,
    corpus: z.array(CorpusDocSchema),
    expect: ExpectedSchema,
    notes: z.string().optional(),
  })
  .superRefine((entry, ctx) => {
    const { action, decision, target_id } = entry.expect;

    if (!REACHABLE[action].includes(decision)) {
      ctx.addIssue({
        code: "custom",
        path: ["expect", "decision"],
        message: `routing: action '${action}' can never route to decision '${decision}' (reachable: ${REACHABLE[action].join(", ")})`,
      });
    }

    const needsTarget = action === "augment" || action === "supersede" || action === "archive";
    if (needsTarget && !target_id) {
      ctx.addIssue({
        code: "custom",
        path: ["expect", "target_id"],
        message: `action '${action}' requires expect.target_id`,
      });
    }
    if (target_id && !entry.corpus.some((doc) => doc.id === target_id)) {
      ctx.addIssue({
        code: "custom",
        path: ["expect", "target_id"],
        message: `expect.target_id '${target_id}' must exist in the corpus`,
      });
    }
  });

export type ConsolidatorFixtureEntry = z.infer<typeof ConsolidatorFixtureEntrySchema>;

export const ConsolidatorFixtureFileSchema = z.array(ConsolidatorFixtureEntrySchema);
export type ConsolidatorFixtureFile = z.infer<typeof ConsolidatorFixtureFileSchema>;

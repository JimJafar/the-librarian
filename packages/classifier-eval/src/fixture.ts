// Fixture schema for classifier evaluation samples (spec §4.7).
//
// Each fixture entry pairs a memory shape with a "ground truth" label
// (the verdict consensus-graded by frontier models, or hand-graded by
// the operator). The eval harness runs every entry through the
// configured classifier and reports agreement.
//
// `category: "straight"` covers clear examples of each quadrant;
// `category: "boundary"` flags cases where the right answer requires
// judgement. The eval splits both ways: a "boundary-only" filter
// surfaces the harder evaluations, while overall agreement is
// computed against the whole sample.

import { z } from "zod";

export const FixtureEntrySchema = z
  .strictObject({
    id: z.string().min(1),
    title: z.string(),
    body: z.string(),
    tags: z.array(z.string()),
    label: z.strictObject({
      requires_approval: z.boolean(),
      is_global: z.boolean(),
    }),
    category: z.enum(["straight", "boundary"]),
    consensus_models: z.array(z.string()).optional(),
  })
  .strict();

export type FixtureEntry = z.infer<typeof FixtureEntrySchema>;

export const FixtureFileSchema = z.array(FixtureEntrySchema);
export type FixtureFile = z.infer<typeof FixtureFileSchema>;

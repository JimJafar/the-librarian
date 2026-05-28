// Prompts used by the `eval generate-fixture` pipeline.
//
// `buildGeneratorPrompt` asks one strong LLM for a batch of candidate
// memories with claimed labels. The 3 graders are then driven by the
// existing classifier v1 prompt (re-exported here so the consensus
// filter is byte-for-byte the same task the classifier worker faces in
// production — that's what makes a unanimous-vote candidate
// "ground truth").

import { loadPromptTemplate, renderPrompt } from "@librarian/classifier";

export interface GeneratorBatchSpec {
  totalCount: number;
  /** Fraction of `totalCount` that should be category=boundary. */
  boundaryRatio: number;
}

export function buildGeneratorPrompt(spec: GeneratorBatchSpec): string {
  const boundary = Math.round(spec.totalCount * spec.boundaryRatio);
  const straight = spec.totalCount - boundary;
  return [
    "You generate synthetic test cases for a memory classifier. Each test case",
    "is a 'memory' — a short note someone wrote to themselves — paired with",
    "the generator's claim about two booleans:",
    "",
    "  - requires_approval: true if the memory contains identity facts,",
    "    relationship facts, or anything an owner would want to review",
    "    before it becomes active. False otherwise.",
    "  - is_global: true if the memory should bypass per-conversation domain",
    "    filtering and be available everywhere (identity, relationships,",
    "    preferences). False if contextual to a domain (tools, projects,",
    "    lessons, environment).",
    "",
    `Generate exactly ${spec.totalCount} memories with this mix:`,
    `  - ${straight} STRAIGHT cases (category="straight"): clear examples`,
    "    covering each of the four (requires_approval, is_global) quadrants.",
    "    Vary the quadrants across straight cases — don't lopside them.",
    `  - ${boundary} BOUNDARY cases (category="boundary"): things that LOOK`,
    "    like one quadrant but belong in another (a tool-shaped note that",
    "    contains a relationship fact; an identity-shaped note that's",
    "    actually a preference; a project memory that's globally relevant).",
    "",
    "Each memory should be 1-3 sentences. Use realistic content. Vary",
    "domains (work, family, coding, hobbies). Avoid generic / repetitive",
    "phrasing.",
    "",
    "Return ONLY a single JSON array, no prose, no markdown fences:",
    "[",
    "  {",
    '    "title": "short title (3-8 words)",',
    '    "body": "1-3 sentence memory body",',
    '    "tags": ["tag1", "tag2"],',
    '    "label": { "requires_approval": false, "is_global": false },',
    '    "category": "straight"',
    "  },",
    "  ...",
    "]",
  ].join("\n");
}

/**
 * Render the classifier's v1 prompt with a candidate's input. This is
 * the exact prompt the production worker uses — running each candidate
 * through it via 3 graders is the consensus filter the spec defines.
 */
export function buildGraderPrompt(candidate: {
  title: string;
  body: string;
  tags: readonly string[];
}): string {
  const template = loadPromptTemplate("v1");
  return renderPrompt(template, candidate);
}

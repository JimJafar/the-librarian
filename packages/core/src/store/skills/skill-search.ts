// Semantic find_skills (plan 036 Phase 5 / spec 035 §F7). Ranks the skill
// manifest against a query with the hybrid index (keyword + vector) over each
// skill's name + description. The index is rebuilt from the manifest per call
// — disposable, like the rest of the index layer, and cheap for the small
// skill set. The embedder is pluggable + async (hash embedder now, the real
// model a drop-in later).

import { type Embedder, buildHybridIndex } from "../index/hybrid-index.js";
import type { SkillManifestEntry } from "./skill-store.js";

export interface SkillSearchHit extends SkillManifestEntry {
  score: number;
}

const DEFAULT_LIMIT = 12;

/**
 * Rank the skill manifest against `query`. Slugs are assumed unique (the store
 * derives them from `skills/<slug>/` directory names); duplicate slugs in the
 * input collapse to one hit.
 */
export async function findSkills(
  skills: SkillManifestEntry[],
  query: string,
  embedder: Embedder,
  limit = DEFAULT_LIMIT,
): Promise<SkillSearchHit[]> {
  const index = await buildHybridIndex(
    skills.map((skill) => ({ id: skill.slug, text: `${skill.name} ${skill.description}` })),
    embedder,
  );
  const hits = await index.search(query, limit);
  const bySlug = new Map(skills.map((skill) => [skill.slug, skill]));
  return hits.flatMap((hit) => {
    const entry = bySlug.get(hit.id);
    return entry ? [{ ...entry, score: hit.score }] : [];
  });
}

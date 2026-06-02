// Skill store — read side (plan 036 Phase 5 / spec 035 §F7). Reads
// `skills/<slug>/SKILL.md` from the vault and projects each one's frontmatter
// into a manifest entry; get_skill returns the full document. Semantic
// find_skills (over the manifest, via the hybrid index) is a follow-up that
// layers on top of listSkills. Greenfield + storage-agnostic: it sits on the
// vault, independent of the memory-doc schema.

import type { Vault } from "../corpus/vault.js";
import { parseSkillDocument } from "./skill-doc.js";

/** A manifest entry: the pointer + the frontmatter projection. */
export interface SkillManifestEntry {
  slug: string;
  name: string;
  description: string;
}

export interface SkillDetail extends SkillManifestEntry {
  body: string;
}

export interface SkillStore {
  /** The manifest: every well-formed skill, sorted by slug. */
  listSkills(): SkillManifestEntry[];
  /** The full skill document, or null if the slug has no SKILL.md. */
  getSkill(slug: string): SkillDetail | null;
}

const SKILLS_ROOT = "skills";

/** "skills/<slug>/SKILL.md" → "<slug>"; null for nested or non-SKILL.md paths. */
function slugOfSkillFile(relPath: string): string | null {
  const parts = relPath.split("/");
  if (parts.length !== 3) return null; // exclude resources/ and deeper nesting
  const [root, slug, file] = parts;
  if (root !== SKILLS_ROOT || file !== "SKILL.md" || !slug) return null;
  return slug;
}

export function createSkillStore(vault: Vault): SkillStore {
  function getSkill(slug: string): SkillDetail | null {
    const raw = vault.tryReadText(`${SKILLS_ROOT}/${slug}/SKILL.md`);
    if (raw === null) return null;
    const { frontmatter, body } = parseSkillDocument(raw);
    return { slug, name: frontmatter.name, description: frontmatter.description, body };
  }

  function listSkills(): SkillManifestEntry[] {
    const entries: SkillManifestEntry[] = [];
    for (const relPath of vault.listMarkdown(SKILLS_ROOT)) {
      const slug = slugOfSkillFile(relPath);
      if (slug === null) continue;
      const raw = vault.tryReadText(relPath);
      if (raw === null) continue;
      try {
        const { frontmatter } = parseSkillDocument(raw);
        entries.push({ slug, name: frontmatter.name, description: frontmatter.description });
      } catch {
        // a malformed SKILL.md is not a valid skill — skip it, don't break the manifest
      }
    }
    return entries.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  }

  return { listSkills, getSkill };
}

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
  /** Resource file paths under the skill dir (e.g. "resources/cheatsheet.md"), sorted. */
  resources: string[];
}

export interface SkillStore {
  /** The manifest: every well-formed skill, sorted by slug. */
  listSkills(): SkillManifestEntry[];
  /**
   * The full skill document, or null if the slug is invalid, has no SKILL.md,
   * or its SKILL.md is malformed (treated as absent, consistent with the
   * manifest — fail-soft, never throws on caller-supplied input).
   */
  getSkill(slug: string): SkillDetail | null;
}

const SKILLS_ROOT = "skills";

/** A slug must name a single directory under skills/ — no path segments / traversal. */
function isValidSlug(slug: string): boolean {
  return (
    slug.length > 0 && !slug.includes("/") && !slug.includes("\\") && slug !== "." && slug !== ".."
  );
}

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
    if (!isValidSlug(slug)) return null;
    const raw = vault.tryReadText(`${SKILLS_ROOT}/${slug}/SKILL.md`);
    if (raw === null) return null;
    try {
      const { frontmatter, body } = parseSkillDocument(raw);
      const skillDir = `${SKILLS_ROOT}/${slug}`;
      const resources = vault
        .listFiles(`${skillDir}/resources`)
        .map((relPath) => relPath.slice(`${skillDir}/`.length)) // → "resources/<file>"
        // drop dotfiles — .gitkeep (the idiomatic empty-dir keeper) and the
        // like aren't author-intended resources, and the vault is git-pushed.
        .filter((rel) => !rel.slice(rel.lastIndexOf("/") + 1).startsWith("."));
      return {
        slug,
        name: frontmatter.name,
        description: frontmatter.description,
        body,
        resources,
      };
    } catch {
      return null; // malformed SKILL.md is treated as absent (matches listSkills)
    }
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

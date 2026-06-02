// Skill <-> markdown-document mapping (plan 036 Phase 5 / spec 035 §F7).
//
// A skill is `skills/<slug>/SKILL.md`: a YAML frontmatter block (the manifest
// fields) + the skill body. Frontmatter is intentionally minimal and matches
// the conventional skill shape — `name` + `description` — so the manifest is a
// pure projection of it. Parsing is strict: a SKILL.md missing either field is
// not a valid skill (the store skips it from the manifest).

import matter from "gray-matter";
import { z } from "zod";

export const SkillFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export interface SkillDocument {
  frontmatter: SkillFrontmatter;
  body: string;
}

/** Parse a SKILL.md; throws if the frontmatter is not a valid skill. */
export function parseSkillDocument(raw: string): SkillDocument {
  const { data, content } = matter(raw);
  const result = SkillFrontmatterSchema.safeParse(data);
  if (!result.success) {
    const detail = result.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Invalid SKILL.md frontmatter: ${detail}`);
  }
  return { frontmatter: result.data, body: content.trim() };
}

// Skills subsystem (plan 036 Phase 5 / spec 035 §F7) — skills as
// `skills/<slug>/SKILL.md` (+ optional resources/), manifest derived from
// frontmatter, retrieved via the store. find_skills (semantic) layers on top.

export {
  type SkillDocument,
  type SkillFrontmatter,
  SkillFrontmatterSchema,
  parseSkillDocument,
} from "./skill-doc.js";
export {
  type SkillDetail,
  type SkillManifestEntry,
  type SkillStore,
  createSkillStore,
} from "./skill-store.js";

// Skill store tests (plan 036 Phase 5 / spec 035 §F7). Skills are
// `skills/<slug>/SKILL.md` (+ optional resources/); the manifest is derived
// from each SKILL.md's frontmatter; get_skill returns the full document. The
// read side is greenfield and storage-agnostic — it sits on the vault, not on
// the memory-doc cutover seam.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSkillStore, createVault } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dataDir: string;
let vault: ReturnType<typeof createVault>;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-skills-"));
  vault = createVault({ vaultPath: path.join(dataDir, "vault") });
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const skill = (name: string, description: string, body: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

describe("createSkillStore", () => {
  it("derives a manifest from each SKILL.md frontmatter, sorted by slug", () => {
    vault.writeText("skills/brewing/SKILL.md", skill("Brewing", "How to brew tea", "## Steps"));
    vault.writeText("skills/archery/SKILL.md", skill("Archery", "How to shoot a bow", "## Form"));
    const store = createSkillStore(vault);
    expect(store.listSkills()).toEqual([
      { slug: "archery", name: "Archery", description: "How to shoot a bow" },
      { slug: "brewing", name: "Brewing", description: "How to brew tea" },
    ]);
  });

  it("excludes resources/ files from the manifest (only top-level SKILL.md counts)", () => {
    vault.writeText("skills/brewing/SKILL.md", skill("Brewing", "How to brew tea", "body"));
    vault.writeText("skills/brewing/resources/SKILL.md", skill("Nested", "Should be ignored", "x"));
    vault.writeText("skills/brewing/resources/notes.md", "# loose notes");
    const store = createSkillStore(vault);
    expect(store.listSkills().map((s) => s.slug)).toEqual(["brewing"]);
  });

  it("get_skill returns the full document (frontmatter + body)", () => {
    vault.writeText(
      "skills/brewing/SKILL.md",
      skill("Brewing", "How to brew tea", "## Steps\nboil water"),
    );
    const store = createSkillStore(vault);
    const detail = store.getSkill("brewing");
    expect(detail).toMatchObject({
      slug: "brewing",
      name: "Brewing",
      description: "How to brew tea",
    });
    expect(detail?.body).toContain("boil water");
  });

  it("get_skill returns null for an unknown slug", () => {
    expect(createSkillStore(vault).getSkill("nope")).toBeNull();
  });

  it("skips a malformed SKILL.md (missing required frontmatter) in the manifest", () => {
    vault.writeText("skills/good/SKILL.md", skill("Good", "fine", "ok"));
    vault.writeText("skills/bad/SKILL.md", "---\nname: OnlyName\n---\n\nno description\n");
    const store = createSkillStore(vault);
    expect(store.listSkills().map((s) => s.slug)).toEqual(["good"]);
  });

  it("returns an empty manifest when there are no skills", () => {
    expect(createSkillStore(vault).listSkills()).toEqual([]);
  });
});

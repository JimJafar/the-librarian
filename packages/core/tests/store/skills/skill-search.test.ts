// Semantic find_skills tests (plan 036 Phase 5 / spec 035 §F7). find_skills
// ranks the skill manifest against a query using the hybrid index (keyword +
// vector) over each skill's name + description. Pluggable async embedder; tests
// use the deterministic hash embedder (the real model is a later drop-in, same
// as the rest of the index layer).

import { type SkillManifestEntry, createHashEmbedder, findSkills } from "@librarian/core";
import { describe, expect, it } from "vitest";

const skills: SkillManifestEntry[] = [
  { slug: "archery", name: "Archery", description: "shooting arrows with a bow" },
  { slug: "brewing", name: "Tea Brewing", description: "steeping loose leaf tea leaves" },
  { slug: "sailing", name: "Sailing", description: "navigating boats across open water" },
];

describe("findSkills", () => {
  it("ranks the matching skill first", async () => {
    const hits = await findSkills(skills, "tea", createHashEmbedder());
    expect(hits[0]?.slug).toBe("brewing");
  });

  it("matches on the name as well as the description", async () => {
    const hits = await findSkills(skills, "arrows bow", createHashEmbedder());
    expect(hits[0]?.slug).toBe("archery");
  });

  it("carries the manifest fields plus a score", async () => {
    const [hit] = await findSkills(skills, "sailing boats", createHashEmbedder());
    expect(hit).toMatchObject({ slug: "sailing", name: "Sailing" });
    expect(typeof hit?.score).toBe("number");
  });

  it("excludes skills that match neither signal", async () => {
    const hits = await findSkills(skills, "tea", createHashEmbedder());
    expect(hits.map((h) => h.slug)).not.toContain("sailing");
  });

  it("respects the limit", async () => {
    const hits = await findSkills(skills, "tea bow water", createHashEmbedder(), 1);
    expect(hits.length).toBeLessThanOrEqual(1);
  });

  it("returns [] for an empty manifest", async () => {
    expect(await findSkills([], "anything", createHashEmbedder())).toEqual([]);
  });
});

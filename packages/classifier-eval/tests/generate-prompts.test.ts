// Generator + grader prompt construction tests.

import { describe, expect, it } from "vitest";
import { buildGeneratorPrompt, buildGraderPrompt } from "../src/generate/prompts.js";

describe("buildGeneratorPrompt", () => {
  it("requests the exact total count and asks for the boundary/straight mix", () => {
    const prompt = buildGeneratorPrompt({ totalCount: 100, boundaryRatio: 0.4 });
    expect(prompt).toContain("Generate exactly 100 memories");
    expect(prompt).toContain("60 STRAIGHT");
    expect(prompt).toContain("40 BOUNDARY");
  });

  it("rounds the boundary count", () => {
    const prompt = buildGeneratorPrompt({ totalCount: 100, boundaryRatio: 0.37 });
    // 100 * 0.37 = 37 boundary, 63 straight
    expect(prompt).toContain("63 STRAIGHT");
    expect(prompt).toContain("37 BOUNDARY");
  });

  it("requests JSON-array output without prose", () => {
    const prompt = buildGeneratorPrompt({ totalCount: 50, boundaryRatio: 0.5 });
    expect(prompt).toContain("Return ONLY a single JSON array");
  });

  it("documents the four-key per-entry shape (title/body/tags/label/category)", () => {
    const prompt = buildGeneratorPrompt({ totalCount: 50, boundaryRatio: 0.5 });
    expect(prompt).toContain('"title"');
    expect(prompt).toContain('"body"');
    expect(prompt).toContain('"tags"');
    expect(prompt).toContain('"label"');
    expect(prompt).toContain('"category"');
  });
});

describe("buildGraderPrompt", () => {
  it("uses the classifier v1 prompt with the candidate fields substituted", () => {
    const prompt = buildGraderPrompt({
      title: "User identity",
      body: "Jim is the operator.",
      tags: ["identity"],
    });
    expect(prompt).toContain("User identity");
    expect(prompt).toContain("Jim is the operator.");
    expect(prompt).toContain("identity");
    expect(prompt).toContain("requires_approval");
    expect(prompt).toContain("is_global");
  });
});

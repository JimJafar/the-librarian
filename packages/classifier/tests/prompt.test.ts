// Prompt template tests — render fills the three placeholders with
// the input fields verbatim. The template file itself is the spec's
// version sentinel (§4.4).

import { describe, expect, it } from "vitest";
import { loadPromptTemplate, renderPrompt } from "../src/prompt.js";

describe("loadPromptTemplate", () => {
  it("loads v1 and includes the structured-output instruction", () => {
    const template = loadPromptTemplate("v1");
    expect(template).toContain("{{title}}");
    expect(template).toContain("{{body}}");
    expect(template).toContain("{{tags}}");
    expect(template).toContain("requires_approval");
    expect(template).toContain("is_global");
  });

  it("returns the same template across repeated reads", () => {
    expect(loadPromptTemplate("v1")).toBe(loadPromptTemplate("v1"));
  });

  it("throws on an unknown version", () => {
    expect(() => loadPromptTemplate("vNEVER")).toThrow(/unknown classifier prompt version/i);
  });
});

describe("renderPrompt", () => {
  it("substitutes all three placeholders", () => {
    const template = loadPromptTemplate("v1");
    const rendered = renderPrompt(template, {
      title: "Test title",
      body: "Test body",
      tags: ["tag1", "tag2"],
    });
    expect(rendered).toContain("TITLE: Test title");
    expect(rendered).toContain("BODY: Test body");
    expect(rendered).toContain("TAGS: tag1, tag2");
    expect(rendered).not.toContain("{{title}}");
    expect(rendered).not.toContain("{{body}}");
    expect(rendered).not.toContain("{{tags}}");
  });

  it("renders an empty tag list as the empty string", () => {
    const template = loadPromptTemplate("v1");
    const rendered = renderPrompt(template, { title: "x", body: "y", tags: [] });
    expect(rendered).toContain("TAGS: \n");
  });
});

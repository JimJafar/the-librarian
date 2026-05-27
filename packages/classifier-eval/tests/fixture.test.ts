// The seed fixture parses against the schema and covers every quadrant.

import { describe, expect, it } from "vitest";
import { loadSeedFixture } from "../src/index.js";

describe("seed fixture", () => {
  const fixture = loadSeedFixture();

  it("loads and parses cleanly", () => {
    expect(fixture.length).toBeGreaterThanOrEqual(10);
  });

  it("covers all four verdict quadrants", () => {
    const quadrants = new Set(
      fixture.map((f) => `${f.label.requires_approval}|${f.label.is_global}`),
    );
    expect(quadrants).toContain("true|true");
    expect(quadrants).toContain("true|false");
    expect(quadrants).toContain("false|true");
    expect(quadrants).toContain("false|false");
  });

  it("includes at least one boundary entry", () => {
    expect(fixture.some((f) => f.category === "boundary")).toBe(true);
  });

  it("ids are unique", () => {
    const ids = fixture.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

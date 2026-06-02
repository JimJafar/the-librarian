// The seed fixture parses against the schema and covers every consolidator
// scenario the Phase-4 checkpoint cares about (S1/S2/S4/S12/S18), and the
// cross-field invariants (target must exist; action↔decision must be a
// routing-reachable pair) are enforced by the schema itself.

import { describe, expect, it } from "vitest";
import {
  CONSOLIDATOR_SCENARIOS,
  ConsolidatorFixtureEntrySchema,
  loadSeedFixture,
} from "../src/index.js";

describe("consolidator seed fixture", () => {
  const fixture = loadSeedFixture();

  it("loads and parses cleanly", () => {
    expect(fixture.length).toBeGreaterThanOrEqual(5);
  });

  it("covers every consolidator scenario (S1/S2/S4/S12/S18)", () => {
    const scenarios = new Set(fixture.map((f) => f.scenario));
    for (const scenario of CONSOLIDATOR_SCENARIOS) {
      expect(scenarios).toContain(scenario);
    }
  });

  it("includes both straight and boundary cases", () => {
    const categories = new Set(fixture.map((f) => f.category));
    expect(categories).toContain("straight");
    expect(categories).toContain("boundary");
  });

  it("exercises the create/augment/supersede branches across the set", () => {
    const actions = new Set(fixture.map((f) => f.expect.action));
    expect(actions).toContain("create");
    expect(actions).toContain("augment");
    expect(actions).toContain("supersede");
  });

  it("references real corpus docs for every targeted action", () => {
    for (const entry of fixture) {
      if (!entry.expect.target_id) continue;
      const ids = entry.corpus.map((d) => d.id);
      expect(ids, `${entry.id} targets a corpus doc`).toContain(entry.expect.target_id);
    }
  });

  it("has unique entry ids", () => {
    const ids = fixture.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("ConsolidatorFixtureEntrySchema cross-field invariants", () => {
  const base = {
    id: "fix_x",
    scenario: "S1" as const,
    category: "straight" as const,
    submission: { text: "A new, novel fact." },
    corpus: [{ id: "mem_1", title: "Unrelated", body: "Something else.", tags: ["x"] }],
    expect: { action: "create" as const, decision: "auto_apply" as const },
  };

  it("accepts a well-formed create entry", () => {
    expect(() => ConsolidatorFixtureEntrySchema.parse(base)).not.toThrow();
  });

  it("rejects an augment without a target_id", () => {
    const bad = { ...base, expect: { action: "augment", decision: "auto_apply" } };
    expect(() => ConsolidatorFixtureEntrySchema.parse(bad)).toThrow(/target_id/);
  });

  it("rejects a target_id that is absent from the corpus", () => {
    const bad = {
      ...base,
      expect: { action: "augment", decision: "auto_apply", target_id: "mem_missing" },
    };
    expect(() => ConsolidatorFixtureEntrySchema.parse(bad)).toThrow(/corpus/);
  });

  it("rejects an action↔decision pair the router can never produce", () => {
    // `create` always routes to auto_apply — `propose` is unreachable.
    const bad = { ...base, expect: { action: "create", decision: "propose" } };
    expect(() => ConsolidatorFixtureEntrySchema.parse(bad)).toThrow(/routing/i);
  });
});

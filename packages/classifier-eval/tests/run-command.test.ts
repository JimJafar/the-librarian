// CLI run-command flag parsing. The classifier wiring + report
// rendering are covered by run.test.ts and soft-alert.test.ts.

import { describe, expect, it } from "vitest";
import { parseRunFlags } from "../src/cli/run-command.js";

describe("parseRunFlags", () => {
  it("parses a complete invocation", () => {
    const flags = parseRunFlags([
      "--provider",
      "remote",
      "--model",
      "gpt-4o-mini",
      "--sample",
      "10",
      "--category",
      "boundary",
      "--json",
    ]);
    expect(flags).toEqual({
      provider: "remote",
      model: "gpt-4o-mini",
      sample: 10,
      category: "boundary",
      json: true,
    });
  });

  it("defaults sample to 10 and category to all", () => {
    const flags = parseRunFlags(["--provider", "remote", "--model", "x"]);
    expect(flags.sample).toBe(10);
    expect(flags.category).toBe("all");
    expect(flags.json).toBe(false);
  });

  it("rejects an unknown provider", () => {
    expect(() => parseRunFlags(["--provider", "potato", "--model", "x"])).toThrow(/--provider/);
  });

  it("rejects an unknown category", () => {
    expect(() =>
      parseRunFlags(["--provider", "remote", "--model", "x", "--category", "bogus"]),
    ).toThrow(/--category/);
  });

  it("rejects a non-positive sample", () => {
    expect(() => parseRunFlags(["--provider", "remote", "--model", "x", "--sample", "0"])).toThrow(
      /--sample/,
    );
  });

  it("captures the --fixture path when provided", () => {
    const flags = parseRunFlags([
      "--provider",
      "remote",
      "--model",
      "x",
      "--fixture",
      "/tmp/my-fixture.json",
    ]);
    expect(flags.fixturePath).toBe("/tmp/my-fixture.json");
  });
});

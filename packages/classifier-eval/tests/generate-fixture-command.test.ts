// CLI flag-parsing tests for `generate-fixture`. The full command's
// HTTP wiring is exercised manually by the operator; here we pin
// only the pure flag-parse + validation surface.

import { describe, expect, it } from "vitest";
import { parseGenerateFixtureFlags } from "../src/cli/generate-fixture-command.js";

describe("parseGenerateFixtureFlags", () => {
  it("parses a minimal invocation with defaults", () => {
    const flags = parseGenerateFixtureFlags([
      "--config",
      "graders.json",
      "--output",
      "fixtures/public-v1.json",
    ]);
    expect(flags).toMatchObject({
      configPath: "graders.json",
      outputPath: "fixtures/public-v1.json",
      target: 900,
      boundaryRatio: 0.4,
      candidatesPerBatch: 100,
      maxIterations: 12,
      maxCalls: 8000,
      dryRun: false,
      verbose: false,
    });
  });

  it("honours every override flag", () => {
    const flags = parseGenerateFixtureFlags([
      "--config",
      "c.json",
      "--output",
      "out.json",
      "--target",
      "120",
      "--boundary-ratio",
      "0.5",
      "--candidates-per-batch",
      "30",
      "--max-iterations",
      "5",
      "--max-calls",
      "200",
      "--dry-run",
      "--verbose",
    ]);
    expect(flags.target).toBe(120);
    expect(flags.boundaryRatio).toBe(0.5);
    expect(flags.candidatesPerBatch).toBe(30);
    expect(flags.maxIterations).toBe(5);
    expect(flags.maxCalls).toBe(200);
    expect(flags.dryRun).toBe(true);
    expect(flags.verbose).toBe(true);
  });

  it("requires --config", () => {
    expect(() => parseGenerateFixtureFlags(["--output", "o.json"])).toThrow(/--config/);
  });

  it("requires --output", () => {
    expect(() => parseGenerateFixtureFlags(["--config", "c.json"])).toThrow(/--output/);
  });

  it("rejects non-positive integer arguments", () => {
    expect(() =>
      parseGenerateFixtureFlags(["--config", "c", "--output", "o", "--target", "0"]),
    ).toThrow(/--target/);
    expect(() =>
      parseGenerateFixtureFlags(["--config", "c", "--output", "o", "--target", "-5"]),
    ).toThrow(/--target/);
    expect(() =>
      parseGenerateFixtureFlags(["--config", "c", "--output", "o", "--target", "1.5"]),
    ).toThrow(/--target/);
  });

  it("rejects boundary-ratio outside [0, 1]", () => {
    expect(() =>
      parseGenerateFixtureFlags(["--config", "c", "--output", "o", "--boundary-ratio", "1.5"]),
    ).toThrow(/boundary-ratio/);
    expect(() =>
      parseGenerateFixtureFlags(["--config", "c", "--output", "o", "--boundary-ratio", "-0.1"]),
    ).toThrow(/boundary-ratio/);
  });
});

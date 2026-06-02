// The `run` command, driven end-to-end with an injected scripted model (no
// network): flag parsing, the dry-run validation path, and the baseline
// round-trip (freeze with --update-baseline, then gate a later run against it).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConsolidationJudgment } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_ENDPOINT, ENV_TOKEN, parseRunFlags, runEvalCommand } from "../src/cli/run-command.js";
import {
  type ConsolidatorFixtureEntry,
  type ScriptedJudgment,
  loadSeedFixture,
  scriptedLlmClient,
} from "../src/index.js";

const fixture = loadSeedFixture();

function oracleJudgment(entry: ConsolidatorFixtureEntry): ConsolidationJudgment {
  const confidence =
    entry.expect.decision === "auto_apply"
      ? 0.99
      : entry.expect.decision === "propose"
        ? 0.9
        : entry.expect.decision === "create_new"
          ? 0.5
          : 0.99;
  const target = entry.expect.target_id ?? "";
  switch (entry.expect.action) {
    case "create":
      return { action: "create", title: "T", body: "B", tags: [], rationale: "r", confidence };
    case "augment":
      return {
        action: "augment",
        target_id: target,
        addition: "New fact.",
        rationale: "r",
        confidence,
      };
    case "supersede":
      return {
        action: "supersede",
        target_id: target,
        title: "T",
        body: "B",
        rationale: "r",
        confidence,
      };
    case "archive":
      return { action: "archive", target_id: target, rationale: "r", confidence };
    default:
      return { action: "noop", rationale: "r", confidence };
  }
}

const oracle = () => ({
  buildClient: () =>
    scriptedLlmClient(
      fixture.map<ScriptedJudgment>((e) => ({
        match: e.submission.text,
        judgment: oracleJudgment(e),
      })),
    ),
});

const alwaysNoop = () => ({
  buildClient: () =>
    scriptedLlmClient(
      fixture.map<ScriptedJudgment>((e) => ({
        match: e.submission.text,
        judgment: { action: "noop", rationale: "r", confidence: 0.99 },
      })),
    ),
});

describe("parseRunFlags", () => {
  it("requires --model", () => {
    expect(() => parseRunFlags([])).toThrow(/--model/);
  });

  it("parses the baseline + gate flags", () => {
    const flags = parseRunFlags([
      "--model",
      "m",
      "--baseline",
      "b.json",
      "--gate",
      "--tolerance",
      "0.1",
    ]);
    expect(flags).toMatchObject({ model: "m", baselinePath: "b.json", gate: true, tolerance: 0.1 });
  });
});

describe("runEvalCommand", () => {
  let dir = "";
  let savedEndpoint: string | undefined;
  let savedToken: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ceval-"));
    savedEndpoint = process.env[ENV_ENDPOINT];
    savedToken = process.env[ENV_TOKEN];
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (savedEndpoint === undefined) delete process.env[ENV_ENDPOINT];
    else process.env[ENV_ENDPOINT] = savedEndpoint;
    if (savedToken === undefined) delete process.env[ENV_TOKEN];
    else process.env[ENV_TOKEN] = savedToken;
  });

  it("dry-run validates the env without calling a model", async () => {
    process.env[ENV_ENDPOINT] = "https://example.test/v1";
    process.env[ENV_TOKEN] = "tok";
    const result = await runEvalCommand(["--model", "m", "--dry-run"]);
    expect(result.report.sample_size).toBe(0);
  });

  it("dry-run fails loud when the env is missing", async () => {
    delete process.env[ENV_ENDPOINT];
    delete process.env[ENV_TOKEN];
    await expect(runEvalCommand(["--model", "m", "--dry-run"])).rejects.toThrow(/ENDPOINT/);
  });

  it("freezes a baseline and then passes the gate on an identical run", async () => {
    const baselinePath = path.join(dir, "baseline.json");
    await runEvalCommand(["--model", "m", "--update-baseline", baselinePath], oracle());
    expect(fs.existsSync(baselinePath)).toBe(true);

    const gated = await runEvalCommand(["--model", "m", "--baseline", baselinePath], oracle());
    expect(gated.gate?.passed).toBe(true);
    expect(gated.gateFailed).toBe(false);
  });

  it("fails the gate when a later run regresses", async () => {
    const baselinePath = path.join(dir, "baseline.json");
    await runEvalCommand(["--model", "m", "--update-baseline", baselinePath], oracle());

    const gated = await runEvalCommand(
      ["--model", "m", "--baseline", baselinePath, "--gate"],
      alwaysNoop(),
    );
    expect(gated.gate?.passed).toBe(false);
    expect(gated.gate?.regressions.length).toBeGreaterThan(0);
    expect(gated.gateFailed).toBe(true);
  });
});

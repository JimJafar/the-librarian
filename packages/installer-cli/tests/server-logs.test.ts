// S4 — `librarian server logs [-f] [--service mcp|dashboard|all]`.
//
// `logs` maps to `docker logs [-f] the-librarian`. The all-in-one image runs
// BOTH services (mcp-server + dashboard) in ONE container under a supervisor
// that uses `stdio: "inherit"` — so it emits NO per-service prefix. The
// mcp-server logs structured pino NDJSON (each line a JSON object carrying
// `"service":"the-librarian"`); the dashboard (Next.js standalone) logs plain
// text. `--service mcp` keeps the NDJSON lines; `--service dashboard` keeps the
// rest; `all` (default) is unfiltered. `-f` follows.

import { afterEach, describe, expect, it } from "vitest";
import { resetRunner } from "../src/exec.js";
import { runCli } from "../src/runtime.js";
import {
  resetRunner as resetDockerRunner,
  setRunner as setDockerRunner,
} from "../src/server/docker.js";
import { FakeRunner, withTempHome } from "./helpers.js";

afterEach(() => {
  resetRunner();
  resetDockerRunner();
});

// A combined log stream: two mcp-server NDJSON lines + two dashboard text lines.
const MCP_LINE_A = '{"level":30,"time":1,"service":"the-librarian","msg":"http listening on 3838"}';
const MCP_LINE_B = '{"level":40,"time":2,"service":"the-librarian","msg":"recall hit"}';
const DASH_LINE_A = "  ▲ Next.js 14.2.0";
const DASH_LINE_B = "  - Local:   http://0.0.0.0:3000";
const COMBINED = [MCP_LINE_A, DASH_LINE_A, MCP_LINE_B, DASH_LINE_B].join("\n") + "\n";

/** docker present + daemon reachable, with a scripted `docker logs` output. */
function dockerReady(logsArgs: string[]): FakeRunner {
  return new FakeRunner()
    .withWhich("docker")
    .withWhich("git")
    .onRun("docker", ["info"], { code: 0 })
    .onRun("docker", logsArgs, { stdout: COMBINED, code: 0 });
}

/** The argv (after `docker`) of the recorded `logs` call. */
function logsArgs(runner: FakeRunner): string[] | undefined {
  return runner.calls.find((c) => c.cmd === "docker" && c.args[0] === "logs")?.args;
}

describe("server logs — default/all is unfiltered", () => {
  it("`logs` maps to `docker logs the-librarian` and prints every line", async () => {
    await withTempHome(async (home) => {
      const runner = dockerReady(["logs", "the-librarian"]);
      setDockerRunner(runner);

      const r = await runCli(["server", "logs"], { home });
      expect(r.exitCode).toBe(0);
      expect(logsArgs(runner)).toEqual(["logs", "the-librarian"]);
      // Unfiltered — both services' lines present.
      expect(r.stdout).toContain("http listening on 3838");
      expect(r.stdout).toContain("Next.js");
    });
  });

  it("`--service all` is explicit-but-unfiltered (no -f)", async () => {
    await withTempHome(async (home) => {
      const runner = dockerReady(["logs", "the-librarian"]);
      setDockerRunner(runner);

      const r = await runCli(["server", "logs", "--service", "all"], { home });
      expect(r.exitCode).toBe(0);
      expect(logsArgs(runner)).toEqual(["logs", "the-librarian"]);
      expect(r.stdout).toContain("http listening on 3838");
      expect(r.stdout).toContain("Next.js");
    });
  });
});

describe("server logs — -f follows", () => {
  it("`-f` adds the follow flag to the docker argv", async () => {
    await withTempHome(async (home) => {
      const runner = dockerReady(["logs", "-f", "the-librarian"]);
      setDockerRunner(runner);

      const r = await runCli(["server", "logs", "-f"], { home });
      expect(r.exitCode).toBe(0);
      expect(logsArgs(runner)).toEqual(["logs", "-f", "the-librarian"]);
    });
  });

  it("`--follow` is the long form of `-f`", async () => {
    await withTempHome(async (home) => {
      const runner = dockerReady(["logs", "-f", "the-librarian"]);
      setDockerRunner(runner);

      const r = await runCli(["server", "logs", "--follow"], { home });
      expect(r.exitCode).toBe(0);
      expect(logsArgs(runner)).toEqual(["logs", "-f", "the-librarian"]);
    });
  });
});

describe("server logs — --service filters the combined stream", () => {
  it("`-f --service mcp` follows AND keeps only the mcp-server (NDJSON) lines", async () => {
    await withTempHome(async (home) => {
      const runner = dockerReady(["logs", "-f", "the-librarian"]);
      setDockerRunner(runner);

      const r = await runCli(["server", "logs", "-f", "--service", "mcp"], { home });
      expect(r.exitCode).toBe(0);
      // docker logs invoked WITH -f.
      expect(logsArgs(runner)).toEqual(["logs", "-f", "the-librarian"]);
      // The mcp (NDJSON) lines are kept...
      expect(r.stdout).toContain("http listening on 3838");
      expect(r.stdout).toContain("recall hit");
      // ...and the dashboard (plain-text) lines are filtered out.
      expect(r.stdout).not.toContain("Next.js");
      expect(r.stdout).not.toContain("Local:");
    });
  });

  it("`--service dashboard` keeps only the dashboard (non-NDJSON) lines", async () => {
    await withTempHome(async (home) => {
      const runner = dockerReady(["logs", "the-librarian"]);
      setDockerRunner(runner);

      const r = await runCli(["server", "logs", "--service", "dashboard"], { home });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Next.js");
      expect(r.stdout).toContain("Local:");
      // The mcp NDJSON lines are filtered out.
      expect(r.stdout).not.toContain("http listening on 3838");
      expect(r.stdout).not.toContain("recall hit");
    });
  });

  it("an unknown --service value teaches the valid choices (no crash)", async () => {
    await withTempHome(async (home) => {
      const runner = dockerReady(["logs", "the-librarian"]);
      setDockerRunner(runner);

      const r = await runCli(["server", "logs", "--service", "frobnicate"], { home });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/mcp/);
      expect(r.stderr).toMatch(/dashboard/);
      expect(r.stderr).toMatch(/all/);
    });
  });
});

describe("server logs — preflight teaches when docker is missing", () => {
  it("docker absent → teaching error", async () => {
    await withTempHome(async (home) => {
      setDockerRunner(new FakeRunner()); // nothing on PATH
      const r = await runCli(["server", "logs"], { home });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/docker/i);
      expect(r.stderr).toMatch(/install/i);
    });
  });
});

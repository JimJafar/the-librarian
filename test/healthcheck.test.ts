// Healthcheck script integration tests.
//
// Ported from test/healthcheck.test.js (node:test) to Vitest as part
// of T5.2's "flip pnpm test to Vitest exclusively" cleanup.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface HealthcheckRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runHealthcheck(extraArgs: string[] = []): Promise<HealthcheckRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--no-warnings", "scripts/healthcheck.js", ...extraArgs],
      {
        cwd: path.resolve("."),
        env: { ...process.env, NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    ) as ChildProcessWithoutNullStreams;
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("healthcheck script", () => {
  it("exits 0 on a clean system", async () => {
    const result = await runHealthcheck();
    expect(
      result.code,
      `healthcheck failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
  });

  it("output names each documented check", async () => {
    const result = await runHealthcheck();
    const text = result.stdout + result.stderr;
    for (const probe of [
      /JSONL append/i,
      /SQLite rebuild/i,
      /session lifecycle/i,
      /MCP stdio/i,
      /HTTP MCP/i,
    ]) {
      expect(text).toMatch(probe);
    }
    expect(text).toMatch(/PASS/);
  });

  it("--help describes its purpose without running checks", async () => {
    const result = await runHealthcheck(["--help"]);
    expect(result.code).toBe(0);
    const text = result.stdout + result.stderr;
    expect(text).toMatch(/healthcheck/i);
    expect(text).toMatch(/usage/i);
  });
});

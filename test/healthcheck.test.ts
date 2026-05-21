// Healthcheck script integration tests.
//
// Ported from test/healthcheck.test.js (node:test) to Vitest as part
// of T5.2's "flip pnpm test to Vitest exclusively" cleanup.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "./helpers.js";

interface HealthcheckRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runHealthcheck(
  extraArgs: string[] = [],
  envOverrides: Record<string, string | undefined> = {},
): Promise<HealthcheckRun> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = { ...process.env, NO_COLOR: "1" } as Record<string, string>;
    for (const [key, value] of Object.entries(envOverrides)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    const child = spawn(
      process.execPath,
      ["--no-warnings", "scripts/healthcheck.js", ...extraArgs],
      {
        cwd: path.resolve("."),
        env,
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
      /MCP tool surface/i,
      /HTTP MCP/i,
    ]) {
      expect(text).toMatch(probe);
    }
    expect(text).toMatch(/PASS/);
  });

  it("MCP tool surface check passes when the registry matches V1.x + S1.x", async () => {
    const result = await runHealthcheck();
    const text = result.stdout + result.stderr;
    expect(text).toMatch(/PASS\s{2}MCP tool surface/);
    expect(text).not.toMatch(/FAIL\s{2}MCP tool surface/);
  });

  it("--help describes its purpose without running checks", async () => {
    const result = await runHealthcheck(["--help"]);
    expect(result.code).toBe(0);
    const text = result.stdout + result.stderr;
    expect(text).toMatch(/healthcheck/i);
    expect(text).toMatch(/usage/i);
  });

  it("--remote probes /healthz + /mcp against an existing server", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({
      dataDir,
      token: "remote-admin",
      agentToken: "remote-agent",
    });
    try {
      const result = await runHealthcheck([
        "--remote",
        server.url,
        "--agent-token",
        "remote-agent",
      ]);
      const text = result.stdout + result.stderr;
      expect(
        result.code,
        `--remote healthcheck failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      ).toBe(0);
      expect(text).toMatch(/mode: remote/);
      expect(text).toMatch(/Remote HTTP reachability \+ auth/);
      expect(text).toMatch(/PASS/);
      expect(text).not.toMatch(/JSONL append/);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("--remote fails fast without a bearer token", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({
      dataDir,
      token: "remote-admin",
      agentToken: "remote-agent",
    });
    try {
      const result = await runHealthcheck(["--remote", server.url], {
        LIBRARIAN_HEALTHCHECK_AGENT_TOKEN: undefined,
        LIBRARIAN_AGENT_TOKEN: undefined,
        LIBRARIAN_ADMIN_TOKEN: undefined,
      });
      const text = result.stdout + result.stderr;
      expect(result.code).toBe(1);
      expect(text).toMatch(/No bearer token available/);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});

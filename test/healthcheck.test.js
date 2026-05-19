import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

function runHealthcheck(extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--no-warnings", "scripts/healthcheck.js", ...extraArgs],
      {
        cwd: path.resolve("."),
        env: { ...process.env, NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
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

test("npm run healthcheck exits 0 on a clean system", async () => {
  const result = await runHealthcheck();
  assert.equal(
    result.code,
    0,
    `healthcheck failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
});

test("healthcheck output names each documented check", async () => {
  const result = await runHealthcheck();
  const text = result.stdout + result.stderr;
  for (const probe of [
    /JSONL append/i,
    /SQLite rebuild/i,
    /session lifecycle/i,
    /MCP stdio/i,
    /HTTP MCP/i,
  ]) {
    assert.match(text, probe, `healthcheck output should mention ${probe}`);
  }
  assert.match(text, /PASS/, "healthcheck should print PASS lines for healthy checks");
});

test("healthcheck --help describes its purpose without running checks", async () => {
  const result = await runHealthcheck(["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout + result.stderr, /healthcheck/i);
  assert.match(result.stdout + result.stderr, /usage/i);
});

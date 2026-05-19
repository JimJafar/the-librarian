#!/usr/bin/env node
// Test-count floor guard.
//
// Runs the legacy node:test suite with the TAP reporter, parses the "1..N" plan
// line, and fails if the count drops below test/baseline.json's `count`.
//
// Rationale: a silent test deletion is the easiest way to lose coverage during
// a multi-phase migration. The baseline is updated deliberately, in a PR, with
// an explanation in the description.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const baselinePath = path.join(repoRoot, "test", "baseline.json");

const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
const floor = Number(baseline.count);
if (!Number.isFinite(floor) || floor < 0) {
  console.error(`[check-test-count] invalid baseline.count in ${baselinePath}`);
  process.exit(2);
}

const testFiles = fs
  .readdirSync(path.join(repoRoot, "test"))
  .filter((name) => name.endsWith(".test.js"))
  .map((name) => path.join("test", name));

if (!testFiles.length) {
  console.error("[check-test-count] no test/*.test.js files found");
  process.exit(2);
}

const args = ["--no-warnings", "--test", "--test-reporter=tap", ...testFiles];
const child = spawn(process.execPath, args, {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "inherit"],
});

let stdout = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});

child.on("error", (err) => {
  console.error(`[check-test-count] failed to spawn node --test: ${err.message}`);
  process.exit(2);
});

child.on("close", (code) => {
  if (code !== 0) {
    console.error(`[check-test-count] node --test exited ${code}; aborting guard`);
    process.exit(code ?? 1);
  }

  const planMatch = stdout.match(/^1\.\.(\d+)\s*$/m);
  if (!planMatch) {
    console.error("[check-test-count] could not find TAP plan line (1..N) in test output");
    process.exit(2);
  }

  const reported = Number(planMatch[1]);
  if (reported < floor) {
    console.error(
      `[check-test-count] FAIL: ${reported} tests reported, floor is ${floor}. ` +
        "Update test/baseline.json in this PR and explain the reduction in the description.",
    );
    process.exit(1);
  }

  console.log(`[check-test-count] OK: ${reported} tests >= floor ${floor}`);
});

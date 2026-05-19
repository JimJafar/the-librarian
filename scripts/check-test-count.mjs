#!/usr/bin/env node
// Test-count floor guard.
//
// Runs node:test (TAP reporter) across every *.test.js under test/ and
// packages/*/tests/, parses the "1..N" plan line, and adds the count to
// every Vitest test discovered across the workspace via `pnpm -r run
// test:vitest --reporter=json`. Fails if the combined total drops below
// test/baseline.json's `count`.
//
// Rationale: a silent test deletion is the easiest way to lose coverage
// during a multi-phase migration. The baseline is updated deliberately,
// in a PR, with an explanation in the description. Counting both runners
// means converting node:test → Vitest is coverage-neutral and does not
// trip the guard.

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

const nodeTestFiles = collectNodeTestFiles(repoRoot);
if (!nodeTestFiles.length) {
  console.error("[check-test-count] no *.test.js files found in test/ or packages/*/tests/");
  process.exit(2);
}

try {
  const nodeCount = await countNodeTests(nodeTestFiles);
  const vitestCount = await countVitestTests();
  const total = nodeCount + vitestCount;

  if (total < floor) {
    console.error(
      `[check-test-count] FAIL: ${total} tests reported (node:test=${nodeCount}, vitest=${vitestCount}), floor is ${floor}. ` +
        "Update test/baseline.json in this PR and explain the reduction in the description.",
    );
    process.exit(1);
  }

  console.log(
    `[check-test-count] OK: ${total} tests (node:test=${nodeCount}, vitest=${vitestCount}) >= floor ${floor}`,
  );
} catch (err) {
  console.error(`[check-test-count] ${err.message}`);
  process.exit(2);
}

function collectNodeTestFiles(root) {
  const out = [];
  const rootTestDir = path.join(root, "test");
  if (fs.existsSync(rootTestDir)) {
    for (const name of fs.readdirSync(rootTestDir)) {
      if (name.endsWith(".test.js")) out.push(path.join("test", name));
    }
  }
  const packagesDir = path.join(root, "packages");
  if (fs.existsSync(packagesDir)) {
    for (const pkg of fs.readdirSync(packagesDir)) {
      const pkgTests = path.join(packagesDir, pkg, "tests");
      if (!fs.existsSync(pkgTests)) continue;
      for (const name of fs.readdirSync(pkgTests)) {
        if (name.endsWith(".test.js")) out.push(path.join("packages", pkg, "tests", name));
      }
    }
  }
  return out;
}

function countNodeTests(testFiles) {
  return new Promise((resolve, reject) => {
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
    child.on("error", (err) => reject(new Error(`failed to spawn node --test: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`node --test exited ${code}; aborting guard`));
        return;
      }
      const planMatch = stdout.match(/^1\.\.(\d+)\s*$/m);
      if (!planMatch) {
        reject(new Error("could not find TAP plan line (1..N) in node:test output"));
        return;
      }
      resolve(Number(planMatch[1]));
    });
  });
}

function countVitestTests() {
  // Discover every package that defines a `test:vitest` script and run
  // each with --reporter=json, summing the reported `numTotalTests`. The
  // root has no Vitest tests today (`@librarian/core` is the first), but
  // every package that adds Vitest gets counted automatically.
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["-r", "exec", "vitest", "run", "--reporter=json"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "inherit"],
      shell: false,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", (err) => reject(new Error(`failed to spawn pnpm vitest: ${err.message}`)));
    child.on("close", () => {
      // pnpm -r exec emits a JSON object per package that ran vitest; we
      // parse each braces-balanced chunk that starts with `{"numTotalTests`.
      let total = 0;
      const matches = stdout.matchAll(/"numTotalTests"\s*:\s*(\d+)/g);
      for (const m of matches) total += Number(m[1]);
      resolve(total);
    });
  });
}

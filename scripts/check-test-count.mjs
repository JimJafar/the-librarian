#!/usr/bin/env node
// Test-count floor guard.
//
// Counts every Vitest test discovered across the workspace (via
// `pnpm -r exec vitest run --reporter=json` for the packages plus a
// root `vitest run --reporter=json` for `test/**/*.test.ts`). Adds
// the count from any remaining `*.test.js` files under test/ or
// packages/*/tests/ via `node --test` so the migration to Vitest is
// coverage-neutral. Fails if the combined total drops below
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

try {
  const nodeCount = nodeTestFiles.length ? await countNodeTests(nodeTestFiles) : 0;
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
  return Promise.all([countWorkspaceVitestTests(), countRootVitestTests()]).then(
    ([workspace, root]) => workspace + root,
  );
}

function countWorkspaceVitestTests() {
  // Run vitest in every workspace package via `pnpm -r exec` so every
  // package that ships a Vitest config gets counted automatically.
  return runJsonReporter(["pnpm", "-r", "exec", "vitest", "run", "--reporter=json"]);
}

function countRootVitestTests() {
  // Run vitest at the repo root (picks up `test/**/*.test.ts` via the
  // root vitest.config.ts). passWithNoTests in the config means this
  // emits a valid JSON report with numTotalTests: 0 if test/ ever
  // empties out.
  return runJsonReporter(["pnpm", "exec", "vitest", "run", "--reporter=json"]);
}

function runJsonReporter(args) {
  return new Promise((resolve, reject) => {
    const [bin, ...rest] = args;
    const child = spawn(bin, rest, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "inherit"],
      shell: false,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", (err) => reject(new Error(`failed to spawn ${bin}: ${err.message}`)));
    child.on("close", () => {
      let total = 0;
      const matches = stdout.matchAll(/"numTotalTests"\s*:\s*(\d+)/g);
      for (const m of matches) total += Number(m[1]);
      resolve(total);
    });
  });
}

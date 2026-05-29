#!/usr/bin/env node
// Guard against re-introduction of the retired `LIBRARIAN_CLASSIFIER_*`
// env contract (see docs/specs/classifier-dashboard-config-spec.md). The
// env vars were replaced by admin-settings persistence read from the
// `/classifier` dashboard cockpit; any new occurrence in source, tests,
// scripts, docker config, or env templates is a regression.
//
// An explicit allowlist of files is permitted to retain the strings:
// the CHANGELOG retroactive note, the classifier-config module that
// owns the `LEGACY_CLASSIFIER_ENV_KEYS` constant, the startup helper
// that emits the env-retired notice, the spec / plan docs the change
// itself referenced, and this script.
//
// Exits 1 with a diff-style report on any unallowed occurrence.

import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const ALLOWED = new Set([
  // CHANGELOG entry naming the retired keys is permanent.
  "CHANGELOG.md",
  // classifier-config owns the `LEGACY_CLASSIFIER_ENV_KEYS` constant.
  "packages/core/src/classifier-config.ts",
  "packages/core/dist/classifier-config.d.ts",
  "packages/core/dist/classifier-config.js",
  "packages/core/dist/index.d.ts",
  "packages/core/dist/index.js",
  // classifier-startup emits the env-retired notice.
  "packages/mcp-server/src/classifier-startup.ts",
  "packages/mcp-server/dist/classifier-startup.d.ts",
  "packages/mcp-server/dist/classifier-startup.js",
  // Tests exercise the env-retirement notice + legacy key detector.
  "packages/core/tests/classifier-config.test.ts",
  "packages/mcp-server/tests/classifier-startup.test.ts",
  // Comment in the boot wiring refers to the retired contract.
  "packages/mcp-server/src/bin/http.ts",
  // classifier-eval is an offline evaluation harness, separate from the
  // production runtime. It keeps its own env contract for endpoint /
  // token because admins drive it from a shell. Migrating it to the
  // settings store is a future independent decision.
  "packages/classifier-eval/src/cli/run-command.ts",
  // local.worker / providers-local: LIBRARIAN_CLASSIFIER_LOCAL_E2E is an
  // integration-test gate, NOT a config knob. Out of scope for the
  // settings-store migration.
  "packages/classifier/src/providers/local.worker.ts",
  "packages/classifier/tests/providers-local.test.ts",
  // Spec / plan docs that describe the retirement itself.
  "docs/specs/classifier-implementation-spec.md",
  "docs/specs/done/classifier-implementation-spec.md",
  "docs/specs/classifier-dashboard-config-spec.md",
  "docs/specs/done/classifier-dashboard-config-spec.md",
  "docs/specs/classifier-dashboard-config-plan.md",
  "docs/specs/done/classifier-dashboard-config-plan.md",
  // The guard itself names the keys it forbids.
  "scripts/check-classifier-env-retirement.mjs",
]);

let stdout = "";
try {
  // Use git grep so the search respects .gitignore (no node_modules, etc.).
  stdout = execSync("git grep -lI 'LIBRARIAN_CLASSIFIER'", {
    cwd: repoRoot,
    encoding: "utf8",
  });
} catch (err) {
  if (err && typeof err === "object" && "status" in err && err.status === 1) {
    // git grep returns 1 when nothing matches — the all-clear path.
    console.log(
      "[check-classifier-env-retirement] OK: no LIBRARIAN_CLASSIFIER_* references found.",
    );
    process.exit(0);
  }
  console.error("[check-classifier-env-retirement] git grep failed:", err);
  process.exit(2);
}

const files = stdout
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean);

const offenders = files.filter((file) => !ALLOWED.has(file));

if (offenders.length === 0) {
  console.log(
    `[check-classifier-env-retirement] OK: ${files.length} reference(s) found, all in allowlisted files.`,
  );
  process.exit(0);
}

console.error("[check-classifier-env-retirement] FAIL:");
console.error(
  "  LIBRARIAN_CLASSIFIER_* env vars are retired " +
    "(see docs/specs/classifier-dashboard-config-spec.md).",
);
console.error("  The following files contain references and are NOT on the allowlist:");
for (const file of offenders) {
  console.error(`    - ${file}`);
}
console.error("");
console.error("  Either remove the references, or add the file to the ALLOWED set in");
console.error("  scripts/check-classifier-env-retirement.mjs with a comment explaining why.");
process.exit(1);

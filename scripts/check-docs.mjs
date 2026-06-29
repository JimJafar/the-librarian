#!/usr/bin/env node
// Drift-guard for the generated docs reference (docs-site spec criterion #5 /
// T2.3). Regenerates the technical-appendix pages from canonical source and
// compares them to what's committed under apps/docs/src/content/docs/reference/.
// Any divergence fails the build, naming the stale page(s) and the fix command —
// so editing a verb description, a parameter, the primer, a CLI command, or an
// included doc without running `pnpm docs:gen` cannot reach main.
//
// Like the generator, this reads the BUILT packages (K8), so CI must run it
// AFTER `pnpm build` — never against stale dist.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateReference } from "./docs-gen.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// Match the trailing-newline normalisation the generator writes with, so a file
// that differs only by its final newline is not falsely flagged as drift.
function normalize(contents) {
  return contents.endsWith("\n") ? contents : `${contents}\n`;
}

function readFromDisk(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

/** The repo-relative paths whose committed content no longer matches a fresh
 *  regeneration (or that are missing entirely). `reference` and `readFile` are
 *  injectable for testing; by default they regenerate and read from disk. */
export function findStaleReferencePages(reference = generateReference(), readFile = readFromDisk) {
  const stale = [];
  for (const [relPath, contents] of Object.entries(reference)) {
    const expected = normalize(contents);
    let actual;
    try {
      actual = readFile(relPath);
    } catch {
      actual = null; // missing file → stale
    }
    if (actual !== expected) stale.push(relPath);
  }
  return stale;
}

function main() {
  const stale = findStaleReferencePages();
  if (stale.length === 0) {
    console.log("check:docs — generated reference pages are in sync.");
    return;
  }
  const list = stale.map((p) => `  - ${p}`).join("\n");
  console.error(
    `check:docs FAILED — these generated reference pages are stale:\n${list}\n\n` +
      "A canonical source changed but the committed reference wasn't regenerated.\n" +
      "Fix:  pnpm docs:gen  (then commit the updated pages)\n" +
      "Note: the generator reads built packages — run `pnpm build` first.",
  );
  process.exit(1);
}

// Only run the check when invoked directly (`pnpm check:docs`); importing the
// comparator (the drift test) must have no side effects.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

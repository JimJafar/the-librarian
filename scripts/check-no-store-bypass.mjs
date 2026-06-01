#!/usr/bin/env node
// Storage-seam guard (F0 — "seal the seam").
//
// The public `LibrarianStore` no longer exposes the raw SQLite handle or the
// event-ledger paths (`db` / `dbPath` / `snapshotPath` / `eventsPath` /
// `readEvents` / `rebuildIndex`). Only the storage layer itself and the
// not-yet-migrated backup (Phase 7) and classifier (Phase 4) subsystems may
// reach them, via the `InternalLibrarianStore` escape hatch.
//
// This guard fails if raw store-handle access appears anywhere else in
// production source, so the seam can't silently re-open between the type-level
// narrowing and the markdown-backend cutover. It tightens automatically: as the
// allowlisted subsystems are retired, their entries should be removed here too.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// Production (non-test) source roots to scan.
const ROOTS = [
  "packages/core/src",
  "packages/mcp-server/src",
  "packages/cli/src",
  "apps/dashboard",
];

// The storage layer owns the handles; backup + classifier are the deferred
// internal-tier consumers (typed `InternalLibrarianStore`) pending their
// Phase 7 / Phase 4 retirement.
function isAllowlisted(rel) {
  return (
    rel.includes("/store/") ||
    rel.includes("/backup/") ||
    /classifier-(startup|worker)\.ts$/.test(rel)
  );
}

function isScannable(rel) {
  if (!/\.tsx?$/.test(rel)) return false;
  if (/\.test\.tsx?$/.test(rel)) return false;
  return true;
}

// Raw store-handle access that must stay behind the seam.
const PATTERNS = [
  /\bstore\.db\b/,
  /\.db\.(prepare|exec)\b/,
  /\bstore\.eventsPath\b/,
  /\bstore\.dbPath\b/,
  /\bstore\.snapshotPath\b/,
  /\.readEvents\(/,
  /\.rebuildIndex\(/,
];

const SKIP_DIRS = new Set(["node_modules", "dist", ".next"]);

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
    } else {
      out.push(full);
    }
  }
}

const violations = [];
for (const root of ROOTS) {
  const files = [];
  walk(path.join(repoRoot, root), files);
  for (const file of files) {
    const rel = path.relative(repoRoot, file).split(path.sep).join("/");
    if (!isScannable(rel) || isAllowlisted(rel)) continue;
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (PATTERNS.some((pattern) => pattern.test(line))) {
        violations.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    });
  }
}

if (violations.length > 0) {
  console.error(
    "[check-no-store-bypass] Raw store-handle access found outside the storage seam.\n" +
      "The public LibrarianStore must not expose db/eventsPath/readEvents/rebuildIndex; route\n" +
      "through a store interface method, or (only for store/**, backup/**, classifier-startup|worker)\n" +
      "use InternalLibrarianStore. Offending lines:",
  );
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log("[check-no-store-bypass] OK — no raw store-handle access outside the storage seam.");

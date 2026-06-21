#!/usr/bin/env node
// Phase-3 caller-id backfill (naming contract §9 Phase 3).
//
// Rewrites stored caller ids to their canonical form:
//   - normalises every non-empty id (§4.2);
//   - applies the one-time backfill alias map below (§9) — distinct from the
//     resolver's LIVE alias map, which stays empty for these ids so `claude`
//     remains available as a future distinct surface (§8/§14);
//   - leaves `unknown-agent` and unnormalisable ids untouched;
//   - records before/after counts and is idempotent on re-run.
//
// Dry-run by default. Use `--apply` to actually rewrite ids.
//
// Usage:
//   node scripts/backfill-agent-ids.mjs                       # dry-run
//   node scripts/backfill-agent-ids.mjs --apply
//   node scripts/backfill-agent-ids.mjs --data-dir ./data --apply
//   LIBRARIAN_DATA_DIR=./data node scripts/backfill-agent-ids.mjs

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { backfillCallerIds, createLibrarianStore } from "@librarian/core";

// One-time backfill mappings. NOT the live resolver alias map — these only
// rewrite stored history. Pure normalisation (e.g. `Bede`/`Guybrush`) is
// applied first; this map covers the SEMANTIC renames the spec approves.
const BACKFILL_ALIASES = {
  // Decided with Guybrush 2026-05-23 (see AUTONOMOUS-BUILD-NOTES):
  claude: "claude-code", // historical Claude Code sessions predate the canonical id
  system: "system-migration", // the CLI seed wrote a bare `system` actor
  // Approved in spec §8 (Hermes Bede is the same actor as Guybrush) + the §9
  // backfill_aliases example. No-op on data dirs without these ids. The LIVE
  // `bede → guybrush` resolver alias is wired in a separate increment.
  bede: "guybrush",
  "guybrush-hermes": "guybrush",
};

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("Usage: node scripts/backfill-agent-ids.mjs [--data-dir <path>] [--apply]");
  process.exit(0);
}

const apply = argv.includes("--apply");
const flagIndex = argv.indexOf("--data-dir");
const dataDirArg = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;
if (flagIndex >= 0 && (dataDirArg === undefined || dataDirArg.startsWith("--"))) {
  console.error("[backfill-agent-ids] --data-dir requires a path argument");
  process.exit(2);
}
const dataDir = path.resolve(dataDirArg ?? process.env.LIBRARIAN_DATA_DIR ?? "./data");

// Guard against a typo'd path silently creating (and seeding empty ledgers in)
// a fresh data dir — there'd be nothing to back-fill, so fail loudly instead.
if (!fs.existsSync(dataDir)) {
  console.error(`[backfill-agent-ids] data dir does not exist: ${dataDir}`);
  process.exit(2);
}

const store = createLibrarianStore({ dataDir });

try {
  const report = backfillCallerIds(store, { aliases: BACKFILL_ALIASES, apply });

  const bar = "=".repeat(64);
  console.log("Caller-id backfill (naming contract §9 Phase 3)");
  console.log(bar);
  console.log(`data dir: ${dataDir}`);
  console.log(`mode:     ${apply ? "APPLY (mutating)" : "dry-run (no changes)"}`);
  console.log(bar);

  printSection("Memories (append-event reattribution)", report.memories);

  const totalChanges = report.memories.changes.length;
  console.log(bar);
  if (totalChanges === 0) {
    console.log("Nothing to backfill — all stored ids are already canonical.");
  } else if (!apply) {
    console.log(`${totalChanges} reattribution group(s) planned. Re-run with --apply to write.`);
  } else {
    console.log(`Applied ${totalChanges} reattribution group(s).`);
  }
} finally {
  store.close();
}

function printSection(heading, section) {
  console.log(`\n${heading}`);
  console.log(`  scanned ${section.scanned} distinct id(s); ${section.changes.length} to change.`);
  for (const change of section.changes) {
    console.log(`    ${change.from}  →  ${change.to}   (${change.count} row(s))`);
  }
  if (section.skipped.length) {
    console.log(`  left untouched: ${section.skipped.join(", ")}`);
  }
}

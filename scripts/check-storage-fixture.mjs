#!/usr/bin/env node
// Storage compatibility fixture guard.
//
// Loads a frozen pre-migration events.jsonl into a temp data dir, constructs a
// LibrarianStore (which rebuilds the SQLite projection from scratch), and
// asserts that the projection produces the expected memory counts.
//
// Catches accidental break of the append-only event format during the
// maintainability overhaul. The fixtures are intentionally frozen — do not
// regenerate them unless the projection contract has genuinely changed.
//
// sessions-rethink PR 7 — the sessions side of this check is retired with
// the rest of the session subsystem. A leftover `sessions.jsonl` next to
// the fixture is renamed to `.predeprecation.bak` on store open so the
// fixture still loads cleanly on a post-PR-7 build.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const fixturesDir = path.join(repoRoot, "test", "fixtures", "pre-migration");

const EXPECTED = {
  memoriesTotal: 3,
  memoriesActive: 2,
  memoriesProposed: 1,
};

const failures = [];
function expect(label, actual, expected) {
  if (actual !== expected) {
    failures.push(`${label}: expected ${expected}, got ${actual}`);
  }
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-fixture-"));
let store;
try {
  fs.copyFileSync(path.join(fixturesDir, "events.jsonl"), path.join(dataDir, "events.jsonl"));
  const legacySessions = path.join(fixturesDir, "sessions.jsonl");
  if (fs.existsSync(legacySessions)) {
    fs.copyFileSync(legacySessions, path.join(dataDir, "sessions.jsonl"));
  }

  const { createLibrarianStore } = await import("@librarian/core");
  store = createLibrarianStore({ dataDir });

  const memoriesResult = store.listMemories({});
  const memories = memoriesResult.memories;
  expect("memoriesTotal", memoriesResult.total, EXPECTED.memoriesTotal);
  expect(
    "memoriesActive",
    memories.filter((m) => m.status === "active").length,
    EXPECTED.memoriesActive,
  );
  expect(
    "memoriesProposed",
    memories.filter((m) => m.status === "proposed").length,
    EXPECTED.memoriesProposed,
  );
} finally {
  if (store) store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

if (failures.length) {
  console.error("[check-storage-fixture] FAIL:");
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    "If this drift is intentional (projection contract changed), regenerate fixtures and update EXPECTED in this script.",
  );
  process.exit(1);
}

const summary = Object.entries(EXPECTED)
  .map(([k, v]) => `${k}=${v}`)
  .join(", ");
console.log(`[check-storage-fixture] OK: ${summary}`);

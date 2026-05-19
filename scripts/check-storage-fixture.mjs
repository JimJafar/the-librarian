#!/usr/bin/env node
// Storage compatibility fixture guard.
//
// Loads frozen pre-migration JSONL ledgers into a temp data dir, constructs a
// LibrarianStore (which rebuilds the SQLite projection from scratch), and
// asserts that the projection produces the expected memory and session counts.
//
// Catches accidental break of the append-only event format during the
// maintainability overhaul. The fixtures are intentionally frozen — do not
// regenerate them unless the projection contract has genuinely changed.

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
  sessionsTotal: 2,
  sessionsActive: 1,
  sessionsPaused: 1,
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
  fs.copyFileSync(path.join(fixturesDir, "sessions.jsonl"), path.join(dataDir, "sessions.jsonl"));

  const { LibrarianStore } = await import(new URL("../src/store.js", import.meta.url).href);
  store = new LibrarianStore({ dataDir });

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

  const allSessions = store.listSessions({
    admin: true,
    include_archived: true,
    include_deleted: true,
    limit: 100,
  });
  expect("sessionsTotal", allSessions.total, EXPECTED.sessionsTotal);
  expect(
    "sessionsActive",
    allSessions.sessions.filter((s) => s.status === "active").length,
    EXPECTED.sessionsActive,
  );
  expect(
    "sessionsPaused",
    allSessions.sessions.filter((s) => s.status === "paused").length,
    EXPECTED.sessionsPaused,
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

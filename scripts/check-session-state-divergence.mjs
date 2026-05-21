#!/usr/bin/env node
// R2 — CI guard that catches divergence between the SQLite-authoritative
// `sessions.status` and the audit trail in `session_state_changes`.
//
// For every session in SQLite:
//   - read the last `to_status` from session_state_changes (the most
//     recent recorded transition);
//   - compare to `sessions.status`.
//   - they must match. A session with zero state-change rows is treated
//     as never-transitioned and skipped (shouldn't happen post-R1 since
//     `startSession` always records a null→active row).
//
// Exits 0 on parity, 1 on divergence with a per-row report.
//
// Runs against a fresh temp store seeded with the storage fixture so CI
// can call it deterministically. Operators can also point it at a live
// data dir via `--data-dir`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

let cleanupDir = null;
let dataDir;
if (args.dataDir) {
  dataDir = path.resolve(args.dataDir);
} else {
  // Default CI mode: seed a fresh temp dir from the pre-migration
  // storage fixture so the check is reproducible without relying on
  // the operator's live ledger. Mirrors check-storage-fixture.mjs.
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-r2-divergence-"));
  cleanupDir = dataDir;
  const fixtureDir = path.join(repoRoot, "test", "fixtures", "pre-migration");
  if (fs.existsSync(fixtureDir)) {
    for (const f of ["events.jsonl", "sessions.jsonl"]) {
      const src = path.join(fixtureDir, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dataDir, f));
    }
  }
}

const { createLibrarianStore } = await import("@librarian/core");
const store = createLibrarianStore({ dataDir });

const sessions = store.db.prepare("SELECT id, status FROM sessions").all();
const divergences = [];

for (const session of sessions) {
  const lastChange = store.db
    .prepare(
      "SELECT to_status FROM session_state_changes WHERE session_id = ? ORDER BY id DESC LIMIT 1",
    )
    .get(session.id);
  if (!lastChange) {
    divergences.push({
      session_id: session.id,
      sqliteStatus: session.status,
      lastTransition: null,
      reason:
        "no session_state_changes row (post-R1 sessions should always have at least the startSession row)",
    });
    continue;
  }
  if (lastChange.to_status !== session.status) {
    divergences.push({
      session_id: session.id,
      sqliteStatus: session.status,
      lastTransition: lastChange.to_status,
      reason: "SQLite status does not match the last recorded transition",
    });
  }
}

store.close();
if (cleanupDir) fs.rmSync(cleanupDir, { recursive: true, force: true });

if (divergences.length) {
  console.error(
    `[check-session-state-divergence] FAIL: ${divergences.length} session(s) diverged from session_state_changes.`,
  );
  for (const d of divergences) {
    console.error(
      `  - ${d.session_id}: status=${d.sqliteStatus} lastTransition=${d.lastTransition ?? "(none)"} — ${d.reason}`,
    );
  }
  process.exit(1);
}

console.log(`[check-session-state-divergence] OK: ${sessions.length} sessions, all in parity.`);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--data-dir") out.dataDir = argv[++i];
    else if (a.startsWith("--data-dir=")) out.dataDir = a.slice("--data-dir=".length);
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node scripts/check-session-state-divergence.mjs [--data-dir <path>]");
      process.exit(0);
    }
  }
  return out;
}

#!/usr/bin/env node
// R2 — one-shot migration from JSONL-canonical sessions to the hybrid
// model:
//
//   - SQLite `sessions` row is the source of current state (already
//     true behaviourally — this just makes the relationship explicit
//     by separating timeline events from state-transition events).
//   - `session_events.jsonl` (new file) carries only timeline events:
//     notes, decisions, attaches, handovers, payload events recorded
//     via `record_session_event`, and `promote_session_fact` audits.
//   - `sessions.legacy.jsonl` is the renamed original ledger, kept
//     read-only as a pre-migration audit anchor.
//
// What the script does:
//   1. Opens the store (which runs R1's ensureSchema → projection
//      rebuild against the new state_version + session_state_changes
//      columns). After this step the SQLite side is fully populated.
//   2. Reads `data/sessions.jsonl` and splits each line by type:
//        - timeline events → appended to `data/session_events.jsonl`
//        - state-transition events (started, checkpointed, paused,
//          ended, and the historical archived/deleted/restored) →
//          skipped; their effect is already encoded in the SQLite
//          state + the session_state_changes audit table.
//   3. Renames `sessions.jsonl` to `sessions.legacy.jsonl`.
//   4. Prints a summary report.
//
// Idempotent: a second run finds no `sessions.jsonl` to read and
// reports zero changes. Re-running is safe.
//
// Dry-run by default. Use `--apply` to actually move files.
//
// Usage:
//   node scripts/migrate-sessions-to-authoritative-sqlite.mjs            # dry-run
//   node scripts/migrate-sessions-to-authoritative-sqlite.mjs --apply
//   node scripts/migrate-sessions-to-authoritative-sqlite.mjs --data-dir ./data

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const dataDir = path.resolve(args.dataDir ?? process.env.LIBRARIAN_DATA_DIR ?? "./data");
const sessionsPath = path.join(dataDir, "sessions.jsonl");
const sessionEventsPath = path.join(dataDir, "session_events.jsonl");
const legacyPath = path.join(dataDir, "sessions.legacy.jsonl");
const apply = args.apply === true;

// Timeline event types — kept in `session_events.jsonl`. The rest
// (Started / Checkpointed / Paused / Ended / Archived / Deleted /
// Restored) are state transitions whose effect is fully captured by
// SQLite + session_state_changes, so they're dropped from the new
// timeline file.
const TIMELINE_EVENT_TYPES = new Set([
  "session.event_recorded",
  "session.attached_to_harness",
  "session.promoted_to_memory",
]);

if (!fs.existsSync(sessionsPath)) {
  if (fs.existsSync(legacyPath)) {
    console.log(
      `[migrate-sessions] already migrated — ${path.relative(process.cwd(), legacyPath)} exists. Nothing to do.`,
    );
    process.exit(0);
  }
  console.error(`[migrate-sessions] FAIL: ${sessionsPath} not found.`);
  process.exit(1);
}

// Open the store before we read JSONL so the R1 projection rebuild
// populates session_state_changes for the historical events.
const { createLibrarianStore } = await import("@librarian/core");
const store = createLibrarianStore({ dataDir });

let timelineLines = 0;
let stateTransitionLines = 0;
let unknownLines = 0;
const timelineOut = [];

const raw = fs.readFileSync(sessionsPath, "utf8");
for (const line of raw.split("\n")) {
  if (!line.trim()) continue;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    unknownLines += 1;
    continue;
  }
  const type = event.event_type;
  if (TIMELINE_EVENT_TYPES.has(type)) {
    timelineLines += 1;
    timelineOut.push(line);
  } else {
    stateTransitionLines += 1;
  }
}

const bar = "=".repeat(60);
console.log("Sessions storage migration");
console.log(bar);
console.log(`data dir:                ${dataDir}`);
console.log(`sessions.jsonl lines:    ${timelineLines + stateTransitionLines + unknownLines}`);
console.log(`  → timeline (kept):     ${timelineLines}`);
console.log(
  `  → state transitions:   ${stateTransitionLines}  (encoded in SQLite + session_state_changes)`,
);
console.log(`  → unparseable (drop):  ${unknownLines}`);
const sessionRows = store.db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n;
const stateChangeRows = store.db.prepare("SELECT COUNT(*) AS n FROM session_state_changes").get().n;
console.log(`SQLite sessions:         ${sessionRows}`);
console.log(`SQLite state changes:    ${stateChangeRows}`);
console.log(bar);

if (!apply) {
  console.log(
    "Dry run only. Re-run with --apply to write session_events.jsonl + rename sessions.jsonl.",
  );
  store.close();
  process.exit(0);
}

// R3 — the runtime creates an empty `session_events.jsonl` on store
// init. Treat empty (or whitespace-only) as a non-conflict; refuse
// only if the file has content (which would mean either a partial
// previous migration or post-R3 timeline writes the operator should
// merge by hand).
if (fs.existsSync(sessionEventsPath)) {
  const existing = fs.readFileSync(sessionEventsPath, "utf8");
  if (existing.trim().length > 0) {
    console.error(
      `[migrate-sessions] FAIL: ${sessionEventsPath} already has content. Refusing to overwrite — investigate before re-running.`,
    );
    store.close();
    process.exit(1);
  }
}

fs.writeFileSync(
  sessionEventsPath,
  timelineOut.join("\n") + (timelineOut.length ? "\n" : ""),
  "utf8",
);
fs.renameSync(sessionsPath, legacyPath);
store.close();

console.log(
  `Wrote ${timelineLines} timeline events to ${path.relative(process.cwd(), sessionEventsPath)}.`,
);
console.log(
  `Renamed sessions.jsonl → ${path.relative(process.cwd(), legacyPath)} (frozen audit anchor).`,
);
console.log(
  "R3 will cut the runtime write paths over to the new file shape; until R3 lands, the runtime still writes to sessions.jsonl on next session activity.",
);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--data-dir") out.dataDir = argv[++i];
    else if (a.startsWith("--data-dir=")) out.dataDir = a.slice("--data-dir=".length);
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node scripts/migrate-sessions-to-authoritative-sqlite.mjs [--data-dir <path>] [--apply]",
      );
      process.exit(0);
    }
  }
  return out;
}

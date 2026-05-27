#!/usr/bin/env node
// Section 4d cutover — enqueue existing memories for re-classification.
//
// On first deploy of 4d.1, the operator runs this once against the
// canonical data dir. It appends one `memory.updated` event per row
// with `payload.patch = { classified: 0, classification_attempts: 0 }`.
// The next projection rebuild replays those events and lands the rows
// at `classified=0`, where the worker picks them up and emits
// `memory.classified` events. Because we're event-sourced, a future
// `pnpm rebuild` does NOT silently revert the migration — the events
// stay on disk forever.
//
// Dry-run by default. Use `--apply` to actually write.
//
// Usage:
//   node scripts/migrate-enqueue-existing-memories.mjs                # dry-run
//   node scripts/migrate-enqueue-existing-memories.mjs --data-dir ./data
//   node scripts/migrate-enqueue-existing-memories.mjs --apply
//
// Idempotent. Re-running --apply against an already-enqueued data dir
// appends a second wave of identical events (the projection sees the
// same patch values and ends at the same state). Not destructive, but
// also not free — the script logs a warning and asks for `--force` on
// the second invocation.
//
// Concurrency: opens the SQLite file with `PRAGMA busy_timeout=5000`
// and wraps the read scan in `BEGIN IMMEDIATE … COMMIT`. The write
// path is JSONL append (atomic) so concurrent mcp-server writes don't
// corrupt either ledger; however, running this while the classifier
// worker is mid-classification can race a verdict that the migration
// then enqueues for re-classification. Recommended: stop mcp-server
// before running `--apply`.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const dataDir = path.resolve(args.dataDir ?? process.env.LIBRARIAN_DATA_DIR ?? "./data");
const apply = args.apply === true;
const force = args.force === true;

const dbPath = path.join(dataDir, "librarian.sqlite");
const eventsPath = path.join(dataDir, "events.jsonl");
if (!fs.existsSync(dbPath)) {
  console.error(`[migrate-enqueue-existing-memories] FAIL: ${dbPath} not found.`);
  process.exit(1);
}
if (!fs.existsSync(eventsPath)) {
  console.error(`[migrate-enqueue-existing-memories] FAIL: ${eventsPath} not found.`);
  process.exit(1);
}

const { DatabaseSync } = await import("node:sqlite");
const db = new DatabaseSync(dbPath);

try {
  db.exec("PRAGMA busy_timeout = 5000");
  // BEGIN IMMEDIATE so a concurrent writer fails fast instead of
  // letting us scan a moving target.
  db.exec("BEGIN IMMEDIATE");
  let rows;
  try {
    rows = db
      .prepare("SELECT id, classified, classification_attempts FROM memories ORDER BY created_at")
      .all();
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const total = rows.length;
  const alreadyZero = rows.filter((r) => Number(r.classified) === 0).length;
  const toEnqueue = total - alreadyZero;

  console.error(`[migrate-enqueue-existing-memories] data dir: ${dataDir}`);
  console.error(`[migrate-enqueue-existing-memories] total memories: ${total}`);
  console.error(`[migrate-enqueue-existing-memories] already at classified=0: ${alreadyZero}`);
  console.error(`[migrate-enqueue-existing-memories] to enqueue: ${toEnqueue}`);

  if (!apply) {
    console.error("[migrate-enqueue-existing-memories] dry-run (pass --apply to write).");
    process.exit(0);
  }

  if (alreadyZero === total && total > 0 && !force) {
    console.error(
      "[migrate-enqueue-existing-memories] every memory is already classified=0 — refusing " +
        "to append a second wave of identical events. Re-run with --force to override.",
    );
    process.exit(0);
  }

  // Append one memory.updated event per row. The Updated handler in
  // packages/core/src/store/projection.ts merges payload.patch into
  // the snapshot, so on next rebuild every row lands at classified=0.
  let written = 0;
  for (const row of rows) {
    const event = {
      event_id: `evt_${randomUUID()}`,
      event_type: "memory.updated",
      memory_id: row.id,
      agent_id: "system",
      actor_kind: "system",
      created_at: new Date().toISOString(),
      payload: {
        memory_id: row.id,
        agent_id: "system",
        patch: { classified: 0, classification_attempts: 0 },
        reason: "classifier-cutover-backfill",
      },
    };
    fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
    written++;
  }
  console.error(`[migrate-enqueue-existing-memories] APPLIED — events appended: ${written}`);
  console.error(
    "[migrate-enqueue-existing-memories] run `pnpm --filter @librarian/cli rebuild` next so " +
      "the projection picks up the new events; the worker will then drain the queue.",
  );
} finally {
  db.close();
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") out.apply = true;
    else if (arg === "--force") out.force = true;
    else if (arg === "--data-dir") out.dataDir = argv[++i];
    else if (arg.startsWith("--data-dir=")) out.dataDir = arg.slice("--data-dir=".length);
  }
  return out;
}

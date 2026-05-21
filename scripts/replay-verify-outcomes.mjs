#!/usr/bin/env node
// Backfill script for V1.3 — replay verify outcomes against the new
// load-bearing semantics introduced in V1.1.
//
// Pre-V1.1, `memory.verified` was effectively a journal entry: the
// projection's old delta rules (useful=+1, not_useful=-1, anything else=-2)
// silently drifted scores around and `outdated` never archived. V1.1
// changed those semantics but did not retroactively re-apply them to
// existing memories. This script walks events.jsonl, finds the *most
// recent* verdict per memory, and synthesises one corrective event:
//
//   - last verdict = outdated     →  memory.archived         (idempotent;
//                                                            skip if already
//                                                            archived)
//   - last verdict = useful       →  memory.usefulness_adjusted with
//                                    score_delta = clamped_target - current
//   - last verdict = not_useful   →  same shape, negative delta
//
// Dry-run by default. Use `--apply` to actually write events.
//
// Usage:
//   node scripts/replay-verify-outcomes.mjs                   # dry-run, defaults
//   node scripts/replay-verify-outcomes.mjs --data-dir ./data
//   node scripts/replay-verify-outcomes.mjs --apply           # writes events
//
// The script is idempotent — running it twice with --apply produces the
// same final projection and no second batch of synthesised events (the
// second run finds nothing to do because the corrective state already
// matches).

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const dataDir = path.resolve(args.dataDir ?? process.env.LIBRARIAN_DATA_DIR ?? "./data");
const eventsPath = path.join(dataDir, "events.jsonl");
const apply = args.apply === true;

if (!fs.existsSync(eventsPath)) {
  console.error(`[replay-verify-outcomes] FAIL: ${eventsPath} not found.`);
  process.exit(1);
}

const { createLibrarianStore } = await import("@librarian/core");

const lines = fs
  .readFileSync(eventsPath, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0);

// Build the plan from the ledger alone — we don't need SQLite for the
// "most recent verdict per memory" computation. Iterating in order means
// the last write wins.
const lastVerify = new Map();
for (const raw of lines) {
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    continue;
  }
  if (event.event_type !== "memory.verified") continue;
  const memoryId = event.memory_id || event.payload?.memory_id;
  const result = event.payload?.result;
  if (!memoryId || !result) continue;
  lastVerify.set(memoryId, { result, agent_id: event.agent_id || "unknown-agent" });
}

// Open the store to read current projection state for each candidate.
// Force a full rebuild so the projection always reflects any events that
// have been appended since the schema sentinel was last bumped — in
// particular, this keeps the backfill idempotent: running --apply twice
// reads the post-first-run state on the second pass.
const store = createLibrarianStore({ dataDir });
store.rebuildIndex();

const planned = { archive: [], adjust: [], skipped: [] };

try {
  for (const [memoryId, { result, agent_id }] of lastVerify.entries()) {
    const memory = store.getMemory(memoryId);
    if (!memory) {
      planned.skipped.push({ memoryId, reason: "missing" });
      continue;
    }
    if (result === "outdated") {
      if (memory.status === "archived") {
        planned.skipped.push({ memoryId, reason: "already archived" });
        continue;
      }
      planned.archive.push({ memoryId, agent_id });
    } else if (result === "useful" || result === "not_useful") {
      // Push the score to the clamp bound matching the verdict so the
      // most recent verdict has maximum effect. Score is already clamped
      // post-V1.1, so memories whose last verdict matches their existing
      // sign are usually a no-op. The single synthesised delta per memory
      // keeps the audit trail small per the spec.
      const target = result === "useful" ? 3 : -3;
      const current = Number(memory.usefulness_score || 0);
      const delta = target - current;
      if (delta === 0) {
        planned.skipped.push({ memoryId, reason: "score already at clamp target" });
        continue;
      }
      planned.adjust.push({ memoryId, agent_id, score_delta: delta });
    } else {
      // legacy "wrong" or any other historical verdict — skipped silently
      planned.skipped.push({ memoryId, reason: `unknown verdict: ${result}` });
    }
  }
} finally {
  store.close();
}

const summary = {
  toArchive: planned.archive.length,
  toAdjust: planned.adjust.length,
  skipped: planned.skipped.length,
  dryRun: !apply,
};
console.log(
  `[replay-verify-outcomes] ${apply ? "APPLY" : "DRY-RUN"}: ` +
    `${summary.toArchive} archived, ${summary.toAdjust} score-adjusted, ${summary.skipped} untouched`,
);

if (!apply) {
  if (planned.archive.length || planned.adjust.length) {
    console.log("[replay-verify-outcomes] Re-run with --apply to write the events above.");
  }
  process.exit(0);
}

const out = fs.openSync(eventsPath, "a");
try {
  for (const item of planned.archive) {
    const event = synthesiseEvent("memory.archived", {
      memory_id: item.memoryId,
      agent_id: item.agent_id,
    });
    fs.writeSync(out, JSON.stringify(event) + "\n");
  }
  for (const item of planned.adjust) {
    const event = synthesiseEvent("memory.usefulness_adjusted", {
      memory_id: item.memoryId,
      agent_id: item.agent_id,
      score_delta: item.score_delta,
      source: "backfill",
    });
    fs.writeSync(out, JSON.stringify(event) + "\n");
  }
} finally {
  fs.closeSync(out);
}

console.log(
  `[replay-verify-outcomes] APPLY done. ` +
    `Restart the mcp-server to pick up the rebuilt projection, or run ` +
    `\`pnpm run rebuild\` against the same data dir.`,
);

// ---------- helpers ----------

function parseArgs(argv) {
  const out = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--data-dir") out.dataDir = argv[++i];
    else if (a.startsWith("--data-dir=")) out.dataDir = a.slice("--data-dir=".length);
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return out;
}

function printHelp() {
  console.log(
    [
      "replay-verify-outcomes — backfill V1.1 verify semantics across the ledger",
      "",
      "  --data-dir <path>   Path to the Librarian data dir (default: $LIBRARIAN_DATA_DIR or ./data)",
      "  --apply             Actually write the events. Without this, the script is a dry-run.",
      "  --help              Show this help.",
    ].join("\n"),
  );
}

function synthesiseEvent(eventType, payload) {
  return {
    event_id: `evt_${randomUUID()}`,
    event_type: eventType,
    memory_id: payload.memory_id,
    agent_id: payload.agent_id,
    created_at: new Date().toISOString(),
    payload,
  };
}

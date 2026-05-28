#!/usr/bin/env node
// T1.4 — Backfill script for the memory-domain-isolation rollout.
//
// PR 1 lands additive schema columns (`domain`, `is_global`,
// `requires_approval` on memories; `domain` on sessions) plus four new
// owner-controlled tables. This script populates the new columns on
// every historical row in the projection per spec §7.2 of
// `docs/specs/memory-domain-isolation-and-conv-state.md`:
//
//   - identity / relationship                    → requires_approval = 1
//   - identity / relationship / preferences      → is_global = 1
//   - everything else                            → both 0
//   - visibility=agent_private                   → domain='legacy-private'
//   - everything else                            → domain='general'
//   - sessions                                   → domain='general'
//   - tags[] gains the original category value (deduped)
//   - identity/relationship also gain a 'profile' tag
//   - if any memory needs 'legacy-private', the script creates that
//     row in the `domains` table on the fly.
//
// Dry-run by default. Use `--apply` to actually write.
//
// Usage:
//   node scripts/migrate-add-domain-and-conv-state.mjs                # dry-run
//   node scripts/migrate-add-domain-and-conv-state.mjs --data-dir ./data
//   node scripts/migrate-add-domain-and-conv-state.mjs --apply
//
// Idempotent. Writes only to the SQLite projection (`librarian.sqlite`) —
// the JSONL ledgers (`events.jsonl`, `session_events.jsonl`) are NOT
// modified. The projection itself derives the same booleans + domain on
// rebuild (see `deriveDomainColumns` in projection.ts), so re-running
// this script after a rebuild produces the same final state.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const dataDir = path.resolve(args.dataDir ?? process.env.LIBRARIAN_DATA_DIR ?? "./data");
const eventsPath = path.join(dataDir, "events.jsonl");
const apply = args.apply === true;

if (!fs.existsSync(eventsPath)) {
  console.error(`[migrate-add-domain-and-conv-state] FAIL: ${eventsPath} not found.`);
  process.exit(1);
}

const { createLibrarianStore } = await import("@librarian/core");

const PROTECTED = new Set(["identity", "relationship"]);
const GLOBAL = new Set(["identity", "relationship", "preferences"]);

const store = createLibrarianStore({ dataDir });

let memoriesBackfilled = 0;
let sessionsBackfilled = 0;
let legacyPrivateMemories = 0;

try {
  // Section 4d.3 — `category`, `visibility`, `scope` columns dropped
  // from memories. This migration's purpose (backfilling them) is
  // obsolete. Detect the post-cutover schema and exit cleanly so
  // operators who run this migration on a fresh data dir don't see a
  // confusing SQL error.
  const cols = store.db.prepare("PRAGMA table_info(memories)").all();
  const hasLegacyColumns = cols.some(
    (c) => c.name === "category" || c.name === "visibility" || c.name === "scope",
  );
  if (!hasLegacyColumns) {
    console.error(
      "[migrate-add-domain-and-conv-state] data dir is post-Section-4d.3 (legacy memory columns dropped); nothing to backfill.",
    );
    store.close();
    process.exit(0);
  }
  const memoryRows = store.db
    .prepare(
      "SELECT id, category, visibility, tags_json, domain, is_global, requires_approval FROM memories",
    )
    .all();

  for (const row of memoryRows) {
    const targetIsGlobal = GLOBAL.has(row.category) ? 1 : 0;
    const targetRequiresApproval = PROTECTED.has(row.category) ? 1 : 0;
    const targetDomain = row.visibility === "agent_private" ? "legacy-private" : "general";

    let tags = parseTags(row.tags_json);
    tags = dedupeAppend(tags, row.category);
    if (PROTECTED.has(row.category)) tags = dedupeAppend(tags, "profile");
    const targetTagsJson = JSON.stringify(tags);

    const drift =
      row.is_global !== targetIsGlobal ||
      row.requires_approval !== targetRequiresApproval ||
      row.domain !== targetDomain ||
      row.tags_json !== targetTagsJson;

    if (drift) memoriesBackfilled++;
    if (targetDomain === "legacy-private") legacyPrivateMemories++;
  }

  // Session rows just normalise their domain to 'general' — this is
  // currently a no-op against the schema default but keeps the script
  // honest as the source of truth for the migration.
  const sessionRows = store.db
    .prepare("SELECT id, domain FROM sessions WHERE domain != 'general'")
    .all();
  sessionsBackfilled = sessionRows.length;

  const verb = apply ? "APPLY" : "DRY-RUN";
  console.log(
    `[migrate-add-domain-and-conv-state] ${verb}: memories backfilled: ${memoriesBackfilled}, ` +
      `sessions backfilled: ${sessionsBackfilled}, legacy-private memories: ${legacyPrivateMemories}`,
  );

  if (!apply) {
    if (memoriesBackfilled || sessionsBackfilled) {
      console.log(
        "[migrate-add-domain-and-conv-state] Re-run with --apply to update the projection.",
      );
    }
    process.exit(0);
  }

  // Apply phase — wrap in a single transaction so a partial failure
  // leaves the projection untouched.
  const tx = store.db.prepare("BEGIN");
  const commit = store.db.prepare("COMMIT");
  const rollback = store.db.prepare("ROLLBACK");
  tx.run();
  try {
    if (legacyPrivateMemories > 0) {
      store.db
        .prepare("INSERT OR IGNORE INTO domains (name, created_at) VALUES (?, ?)")
        .run("legacy-private", new Date().toISOString());
    }

    const updateMemory = store.db.prepare(
      "UPDATE memories SET domain = ?, is_global = ?, requires_approval = ?, tags_json = ? WHERE id = ?",
    );
    for (const row of memoryRows) {
      const targetIsGlobal = GLOBAL.has(row.category) ? 1 : 0;
      const targetRequiresApproval = PROTECTED.has(row.category) ? 1 : 0;
      const targetDomain = row.visibility === "agent_private" ? "legacy-private" : "general";

      let tags = parseTags(row.tags_json);
      tags = dedupeAppend(tags, row.category);
      if (PROTECTED.has(row.category)) tags = dedupeAppend(tags, "profile");
      const targetTagsJson = JSON.stringify(tags);

      updateMemory.run(
        targetDomain,
        targetIsGlobal,
        targetRequiresApproval,
        targetTagsJson,
        row.id,
      );
    }

    store.db.prepare("UPDATE sessions SET domain = 'general' WHERE domain != 'general'").run();

    commit.run();
  } catch (error) {
    rollback.run();
    throw error;
  }

  console.log(
    "[migrate-add-domain-and-conv-state] APPLY done. The classifier cutover (PR 7) will replace " +
      "this category-derived bridge with the local-model verdict.",
  );
} finally {
  store.close();
}

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
      "migrate-add-domain-and-conv-state — PR 1 backfill for memory-domain-isolation",
      "",
      "  --data-dir <path>   Path to the Librarian data dir (default: $LIBRARIAN_DATA_DIR or ./data)",
      "  --apply             Apply updates. Without this, the script is a dry-run.",
      "  --help              Show this help.",
    ].join("\n"),
  );
}

function parseTags(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function dedupeAppend(tags, value) {
  if (!value) return tags;
  return tags.includes(value) ? tags : [...tags, value];
}

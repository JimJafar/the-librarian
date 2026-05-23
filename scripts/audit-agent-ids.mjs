#!/usr/bin/env node
// Baseline caller-id audit (naming contract §9 Phase 0) — read-only dry-run.
//
// Reports how `normaliseCallerId` would collapse the existing stored caller ids
// (memories.agent_id, sessions.created_by_agent_id / current_agent_id) BEFORE
// any backfill, so collapse groups + collisions can be reviewed and aliases
// decided deliberately (§10). Changes nothing; always exits 0.
//
// Usage: node scripts/audit-agent-ids.mjs [--data-dir <path>]
//        LIBRARIAN_DATA_DIR=<path> node scripts/audit-agent-ids.mjs

import path from "node:path";
import process from "node:process";
import { auditCallerIds, createLibrarianStore } from "@librarian/core";

const argv = process.argv.slice(2);
const flagIndex = argv.indexOf("--data-dir");
const dataDirArg = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;
const dataDir = path.resolve(dataDirArg ?? process.env.LIBRARIAN_DATA_DIR ?? "./data");

const store = createLibrarianStore({ dataDir });

try {
  const rawIds = [
    ...store.distinctValues({ field: "agent_id", include_archived: true }),
    ...store.distinctSessionValues({ field: "created_by_agent_id", include_ended: true }),
    ...store.distinctSessionValues({ field: "current_agent_id", include_ended: true }),
  ];

  const audit = auditCallerIds(rawIds);

  console.log(`[audit-agent-ids] data dir: ${dataDir}`);
  console.log(
    `[audit-agent-ids] ${audit.total} distinct caller id(s); ${audit.groups.length} canonical, ` +
      `${audit.collapses.length} collapse group(s), ${audit.invalid.length} invalid.\n`,
  );

  if (audit.collapses.length) {
    console.log("Collapse groups (multiple raw variants → one canonical):");
    for (const group of audit.collapses) {
      console.log(
        `  ${group.canonical}  ←  ${group.variants.map((v) => JSON.stringify(v)).join(", ")}`,
      );
    }
    console.log("");
  }

  const clean = audit.groups.filter((group) => group.variants.length === 1);
  if (clean.length) {
    console.log("Already-canonical ids:");
    console.log(`  ${clean.map((group) => group.canonical).join(", ")}\n`);
  }

  if (audit.invalid.length) {
    console.log("Invalid (no canonical form — would be rejected):");
    for (const raw of audit.invalid) console.log(`  ${JSON.stringify(raw)}`);
    console.log("");
  }

  if (audit.groups.some((group) => group.canonical === "unknown-agent")) {
    console.log("Note: `unknown-agent` is the legacy sentinel — leave it untouched in backfill.");
  }
} finally {
  store.close();
}

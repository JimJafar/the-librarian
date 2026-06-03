#!/usr/bin/env node
// seed extract — dump an existing SQLite store's ACTIVE memories to JSON (one
// file per memory) for replay by import.mjs. Read-only on the db. See README.md.
//
//   node scripts/seed/extract.mjs --db <sqlite-dataDir> --out <extract-dir>

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { createLibrarianStore } from "@librarian/core";
import { extractActiveMemories } from "./lib.mjs";

const { values } = parseArgs({
  options: { db: { type: "string" }, "data-dir": { type: "string" }, out: { type: "string" } },
  strict: true,
});
const dataDir = values.db ?? values["data-dir"];
const out = values.out;
if (!dataDir || !out) {
  console.error("usage: node scripts/seed/extract.mjs --db <sqlite-dataDir> --out <extract-dir>");
  process.exit(2);
}

const store = createLibrarianStore({ dataDir, backend: "sqlite" });
try {
  const records = extractActiveMemories(store);
  fs.mkdirSync(out, { recursive: true });
  records.forEach((rec, i) => {
    fs.writeFileSync(
      path.join(out, `${String(i + 1).padStart(5, "0")}.json`),
      `${JSON.stringify(rec, null, 2)}\n`,
    );
  });
  console.log(`seed extract: wrote ${records.length} active memories → ${out}`);
} finally {
  store.close();
}

#!/usr/bin/env node
// Schema-version guard.
//
// Hashes the canonical projection DDL (`SCHEMA_DDL` from
// `@librarian/core/store-internal`) and compares it to the recorded
// fingerprint in `test/schema-snapshot.json`. The snapshot records
// `{ version, fingerprint }` — the contract is: if you change the DDL
// you must also bump `PROJECTION_SCHEMA_VERSION` and update the
// snapshot in the same PR.
//
// Without this guard, a contributor can change the SQLite shape (add a
// column, new table) and forget to bump the version sentinel — leaving
// existing installs with a stale projection that silently breaks.
//
// Run `node scripts/check-schema-version.mjs --update` after a
// deliberate schema change to regenerate the snapshot. CI runs the
// check without `--update`.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const snapshotPath = path.join(repoRoot, "test", "schema-snapshot.json");

const { PROJECTION_SCHEMA_VERSION, SCHEMA_DDL } = await import("@librarian/core/store-internal");

const currentFingerprint = sha256(SCHEMA_DDL);
const update = process.argv.includes("--update");

if (update) {
  const next = { version: PROJECTION_SCHEMA_VERSION, fingerprint: currentFingerprint };
  fs.writeFileSync(snapshotPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  console.log(
    `[check-schema-version] snapshot updated: version=${next.version} fingerprint=${next.fingerprint}`,
  );
  process.exit(0);
}

if (!fs.existsSync(snapshotPath)) {
  console.error(
    `[check-schema-version] FAIL: ${snapshotPath} does not exist. ` +
      "Run `node scripts/check-schema-version.mjs --update` to create it.",
  );
  process.exit(1);
}

const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
const fingerprintMatches = snapshot.fingerprint === currentFingerprint;
const versionMatches = snapshot.version === PROJECTION_SCHEMA_VERSION;

if (fingerprintMatches && versionMatches) {
  console.log(
    `[check-schema-version] OK: version=${PROJECTION_SCHEMA_VERSION} fingerprint=${currentFingerprint}`,
  );
  process.exit(0);
}

const lines = ["[check-schema-version] FAIL:"];

if (!fingerprintMatches) {
  lines.push(
    `  SCHEMA_DDL fingerprint changed`,
    `    recorded: ${snapshot.fingerprint}`,
    `    current:  ${currentFingerprint}`,
    "",
    "  The projection schema has been edited. You must:",
    "    1. Bump PROJECTION_SCHEMA_VERSION in packages/core/src/store/projection.ts",
    "    2. Run `node scripts/check-schema-version.mjs --update` to refresh the snapshot",
    "    3. Re-run this check",
  );
}

if (!versionMatches && fingerprintMatches) {
  lines.push(
    `  PROJECTION_SCHEMA_VERSION (${PROJECTION_SCHEMA_VERSION}) does not match the snapshot ` +
      `(${snapshot.version}) but the DDL fingerprint is unchanged.`,
    "  Either revert the version change or update the snapshot via " +
      "`node scripts/check-schema-version.mjs --update`.",
  );
} else if (!versionMatches && !fingerprintMatches) {
  lines.push(
    "",
    `  Note: PROJECTION_SCHEMA_VERSION is ${PROJECTION_SCHEMA_VERSION}, snapshot is ${snapshot.version}.`,
  );
}

console.error(lines.join("\n"));
process.exit(1);

function sha256(input) {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

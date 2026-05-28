// Section 4d.3 — the `category` / `visibility` / `scope` columns this
// migration backfilled are dropped. The script now detects a
// post-cutover schema and exits cleanly. The original behavioural
// assertions are gone with the columns; this regression test confirms
// the no-op path stays no-op.

import { exec as execCb } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createLibrarianStore } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const exec = promisify(execCb);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "migrate-add-domain-and-conv-state.mjs");

let dataDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-domain-migrate-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("migrate-add-domain-and-conv-state (Section 4d.3 — no-op on post-cutover schema)", () => {
  it("exits cleanly with a no-op message on a data dir whose memories table lacks category", async () => {
    const store = createLibrarianStore({ dataDir });
    store.close();
    const { stderr } = await exec(`node "${scriptPath}" --data-dir "${dataDir}"`);
    expect(stderr).toMatch(/post-Section-4d\.3|nothing to backfill/i);
  });
});

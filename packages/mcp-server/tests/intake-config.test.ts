// Intake (intake) legacy-env seam (spec 043 D-E). Intake enablement itself
// now reads the `curator.intake.enabled` setting (authoritative) via core's
// `isIntakeEnabled` — covered by core's curator-enablement suite; the predicate is
// no longer duplicated in mcp-server (D-5/F21). What remains here is the legacy
// LIBRARIAN_CONSOLIDATOR env, retired to a seed-once + deprecation-warn role: these
// tests pin its env→deprecation detection and its one-time migration seed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  INTAKE_ENABLED_KEY,
  type LibrarianStore,
  createLibrarianStore,
  isIntakeEnabled,
  migrateCuratorEnablement,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Import the compiled module: vitest externalizes packages/mcp-server/{src,dist}
// (see vitest.config.ts), so a `../src/*.ts` import hits Node's loader, which
// cannot load .ts. Other internal-module tests (e.g. http/db-tokens) import from
// dist for the same reason; dist is built before test:vitest runs.
import { isLegacyIntakeEnvSet, legacyIntakeEnvValue } from "../dist/intake-config.js";

let store: LibrarianStore | null = null;
let dataDir = "";
let savedEnv: string | undefined;

function makeStore(): LibrarianStore {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-intake-cfg-"));
  store = createLibrarianStore({ dataDir });
  return store;
}

beforeEach(() => {
  savedEnv = process.env.LIBRARIAN_CONSOLIDATOR;
  delete process.env.LIBRARIAN_CONSOLIDATOR;
});

afterEach(() => {
  try {
    store?.close();
  } catch {
    /* ignore */
  }
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  store = null;
  dataDir = "";
  if (savedEnv === undefined) delete process.env.LIBRARIAN_CONSOLIDATOR;
  else process.env.LIBRARIAN_CONSOLIDATOR = savedEnv;
});

describe("intake-config (intake legacy-env seam, spec 043 D-E)", () => {
  it("boot-style migration seeds the setting from the env, then the setting wins", () => {
    const s = makeStore();
    process.env.LIBRARIAN_CONSOLIDATOR = "on";

    migrateCuratorEnablement(s, { legacyIntakeEnv: legacyIntakeEnvValue() });
    expect(isIntakeEnabled(s)).toBe(true); // exact enablement preserved

    // Operator toggles off; re-running boot migration must not re-enable.
    s.setSetting(INTAKE_ENABLED_KEY, "false");
    migrateCuratorEnablement(s, { legacyIntakeEnv: legacyIntakeEnvValue() });
    expect(isIntakeEnabled(s)).toBe(false);
  });

  it("detects the deprecated env var while it is set (drives the boot warning)", () => {
    expect(isLegacyIntakeEnvSet()).toBe(false);
    process.env.LIBRARIAN_CONSOLIDATOR = "on";
    expect(isLegacyIntakeEnvSet()).toBe(true);
    expect(legacyIntakeEnvValue()).toBe("on");

    // Set to anything (even "off") still counts as present → deprecation warn fires.
    process.env.LIBRARIAN_CONSOLIDATOR = "off";
    expect(isLegacyIntakeEnvSet()).toBe(true);

    delete process.env.LIBRARIAN_CONSOLIDATOR;
    expect(isLegacyIntakeEnvSet()).toBe(false);
    expect(legacyIntakeEnvValue()).toBeUndefined();
  });
});

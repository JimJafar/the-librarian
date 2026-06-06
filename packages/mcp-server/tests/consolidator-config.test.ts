// Consolidator (intake) enablement seam (spec 043 D-E). Intake enablement now
// reads the `curator.intake.enabled` setting (authoritative); the legacy
// LIBRARIAN_CONSOLIDATOR env is retired to a seed-once + deprecation-warn role.
// These tests pin the env→deprecation detection and the store-backed gate.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  INTAKE_ENABLED_KEY,
  type LibrarianStore,
  createLibrarianStore,
  migrateCuratorEnablement,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Import the compiled module: vitest externalizes packages/mcp-server/{src,dist}
// (see vitest.config.ts), so a `../src/*.ts` import hits Node's loader, which
// cannot load .ts. Other internal-module tests (e.g. http/db-tokens) import from
// dist for the same reason; dist is built before test:vitest runs.
import {
  isConsolidatorEnabled,
  isLegacyConsolidatorEnvSet,
  legacyConsolidatorEnv,
} from "../dist/consolidator-config.js";

let store: LibrarianStore | null = null;
let dataDir = "";
let savedEnv: string | undefined;

function makeStore(): LibrarianStore {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-consolidator-cfg-"));
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

describe("consolidator-config (intake enablement seam, spec 043 D-E)", () => {
  it("isConsolidatorEnabled reads the setting, not the env", () => {
    const s = makeStore();
    // Env on, setting unset → still off (the env no longer gates the job).
    process.env.LIBRARIAN_CONSOLIDATOR = "on";
    expect(isConsolidatorEnabled(s)).toBe(false);

    s.setSetting(INTAKE_ENABLED_KEY, "true");
    expect(isConsolidatorEnabled(s)).toBe(true);

    // Setting authoritative: env on but setting off → off.
    s.setSetting(INTAKE_ENABLED_KEY, "false");
    expect(isConsolidatorEnabled(s)).toBe(false);
  });

  it("boot-style migration seeds the setting from the env, then the setting wins", () => {
    const s = makeStore();
    process.env.LIBRARIAN_CONSOLIDATOR = "on";

    migrateCuratorEnablement(s, { legacyIntakeEnv: legacyConsolidatorEnv() });
    expect(isConsolidatorEnabled(s)).toBe(true); // exact enablement preserved

    // Operator toggles off; re-running boot migration must not re-enable.
    s.setSetting(INTAKE_ENABLED_KEY, "false");
    migrateCuratorEnablement(s, { legacyIntakeEnv: legacyConsolidatorEnv() });
    expect(isConsolidatorEnabled(s)).toBe(false);
  });

  it("detects the deprecated env var while it is set (drives the boot warning)", () => {
    expect(isLegacyConsolidatorEnvSet()).toBe(false);
    process.env.LIBRARIAN_CONSOLIDATOR = "on";
    expect(isLegacyConsolidatorEnvSet()).toBe(true);
    expect(legacyConsolidatorEnv()).toBe("on");

    // Set to anything (even "off") still counts as present → deprecation warn fires.
    process.env.LIBRARIAN_CONSOLIDATOR = "off";
    expect(isLegacyConsolidatorEnvSet()).toBe(true);

    delete process.env.LIBRARIAN_CONSOLIDATOR;
    expect(isLegacyConsolidatorEnvSet()).toBe(false);
    expect(legacyConsolidatorEnv()).toBeUndefined();
  });
});

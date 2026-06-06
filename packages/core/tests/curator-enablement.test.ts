// Unified curator enablement + legacy migration (spec 043 D-E).
//
// Both curator jobs' on/off flags now live under the `curator.*` namespace as
// dashboard-editable settings (curator.grooming.enabled / curator.intake.enabled),
// replacing the two legacy sources (the curator.enabled setting for grooming and
// the LIBRARIAN_CONSOLIDATOR env var for intake). migrateCuratorEnablement seeds
// the new keys ONCE so an existing install keeps its exact enablement after the
// upgrade, never clobbering a value the user has since set, and stays idempotent.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GROOMING_ENABLED_KEY,
  INTAKE_ENABLED_KEY,
  LEGACY_GROOMING_ENABLED_KEY,
  type LibrarianStore,
  createLibrarianStore,
  isIntakeEnabled,
  migrateCuratorEnablement,
  readCuratorConfig,
  setIntakeEnabled,
  writeCuratorConfig,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface Scope {
  store: LibrarianStore;
  dataDir: string;
}

function open(dataDir: string): LibrarianStore {
  return createLibrarianStore({ dataDir });
}

function scope(): Scope {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-enablement-"));
  return { store: open(dataDir), dataDir };
}

function teardown(s: Scope | null): void {
  if (!s) return;
  try {
    s.store.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(s.dataDir, { recursive: true, force: true });
}

describe("curator enablement migration (spec 043 D-E)", () => {
  let s: Scope | null = null;
  beforeEach(() => {
    s = scope();
  });
  afterEach(() => {
    teardown(s);
    s = null;
  });

  // ── Acceptance: an old install keeps its EXACT enablement after upgrade ──────

  it("preserves grooming-on: curator.enabled=true seeds curator.grooming.enabled=true", () => {
    const { store } = s!;
    store.setSetting(LEGACY_GROOMING_ENABLED_KEY, "true"); // pre-043 grooming on
    expect(readCuratorConfig(store).enabled).toBe(false); // not yet migrated

    migrateCuratorEnablement(store);

    expect(store.getSetting(GROOMING_ENABLED_KEY)).toBe("true");
    expect(readCuratorConfig(store).enabled).toBe(true);
  });

  it("preserves grooming-off: curator.enabled=false seeds curator.grooming.enabled=false", () => {
    const { store } = s!;
    store.setSetting(LEGACY_GROOMING_ENABLED_KEY, "false");

    migrateCuratorEnablement(store);

    expect(store.getSetting(GROOMING_ENABLED_KEY)).toBe("false");
    expect(readCuratorConfig(store).enabled).toBe(false);
  });

  it("preserves intake-on: LIBRARIAN_CONSOLIDATOR=on seeds curator.intake.enabled=true", () => {
    const { store } = s!;
    expect(isIntakeEnabled(store)).toBe(false); // default off pre-migration

    migrateCuratorEnablement(store, { legacyIntakeEnv: "on" });

    expect(store.getSetting(INTAKE_ENABLED_KEY)).toBe("true");
    expect(isIntakeEnabled(store)).toBe(true);
  });

  it("treats LIBRARIAN_CONSOLIDATOR=true the same as on", () => {
    const { store } = s!;
    migrateCuratorEnablement(store, { legacyIntakeEnv: "true" });
    expect(isIntakeEnabled(store)).toBe(true);
  });

  // ── Acceptance: the setting is authoritative (toggle works) ─────────────────

  it("lets the setting be toggled off even when the legacy env was on (setting wins)", () => {
    const { store } = s!;
    // Existing install: env on → migration seeds the setting on.
    migrateCuratorEnablement(store, { legacyIntakeEnv: "on" });
    expect(isIntakeEnabled(store)).toBe(true);

    // User toggles intake OFF from the dashboard.
    store.setSetting(INTAKE_ENABLED_KEY, "false");
    expect(isIntakeEnabled(store)).toBe(false);

    // A subsequent boot re-runs the migration with the env STILL set on — it must
    // NOT re-enable intake (no-clobber). The setting stays authoritative.
    migrateCuratorEnablement(store, { legacyIntakeEnv: "on" });
    expect(isIntakeEnabled(store)).toBe(false);
  });

  it("lets grooming be toggled off after migrating from an on legacy setting", () => {
    const { store } = s!;
    store.setSetting(LEGACY_GROOMING_ENABLED_KEY, "true");
    migrateCuratorEnablement(store);
    expect(readCuratorConfig(store).enabled).toBe(true);

    writeCuratorConfig(store, { enabled: false });
    expect(readCuratorConfig(store).enabled).toBe(false);

    // Re-running migration (legacy curator.enabled still "true") must not clobber.
    migrateCuratorEnablement(store);
    expect(readCuratorConfig(store).enabled).toBe(false);
  });

  // ── Acceptance: idempotent + never clobbers an explicit new-key value ────────

  it("never clobbers an explicit curator.grooming.enabled value", () => {
    const { store } = s!;
    store.setSetting(GROOMING_ENABLED_KEY, "false"); // user set it off
    store.setSetting(LEGACY_GROOMING_ENABLED_KEY, "true"); // legacy says on

    migrateCuratorEnablement(store);

    expect(store.getSetting(GROOMING_ENABLED_KEY)).toBe("false"); // explicit value preserved
  });

  it("never clobbers an explicit curator.intake.enabled value", () => {
    const { store } = s!;
    store.setSetting(INTAKE_ENABLED_KEY, "false"); // user set it off

    migrateCuratorEnablement(store, { legacyIntakeEnv: "on" }); // legacy env says on

    expect(store.getSetting(INTAKE_ENABLED_KEY)).toBe("false"); // explicit value preserved
  });

  it("is idempotent: re-running yields the same settings (no drift)", () => {
    const { store } = s!;
    store.setSetting(LEGACY_GROOMING_ENABLED_KEY, "true");

    migrateCuratorEnablement(store, { legacyIntakeEnv: "on" });
    const after1 = {
      grooming: store.getSetting(GROOMING_ENABLED_KEY),
      intake: store.getSetting(INTAKE_ENABLED_KEY),
    };
    migrateCuratorEnablement(store, { legacyIntakeEnv: "on" });
    const after2 = {
      grooming: store.getSetting(GROOMING_ENABLED_KEY),
      intake: store.getSetting(INTAKE_ENABLED_KEY),
    };

    expect(after2).toEqual(after1);
    expect(after2).toEqual({ grooming: "true", intake: "true" });
  });

  // ── Fresh install: no legacy sources → both jobs default off ─────────────────

  it("leaves both keys unset on a fresh install (no legacy sources), defaulting off", () => {
    const { store } = s!;
    migrateCuratorEnablement(store); // no legacy setting, no env

    expect(store.getSetting(GROOMING_ENABLED_KEY)).toBeNull();
    expect(store.getSetting(INTAKE_ENABLED_KEY)).toBeNull();
    expect(readCuratorConfig(store).enabled).toBe(false);
    expect(isIntakeEnabled(store)).toBe(false);
  });

  it("does not seed intake when the env is off/absent", () => {
    const { store } = s!;
    migrateCuratorEnablement(store, { legacyIntakeEnv: "off" });
    expect(store.getSetting(INTAKE_ENABLED_KEY)).toBeNull();
    expect(isIntakeEnabled(store)).toBe(false);
  });

  // ── readCuratorConfig now round-trips through the unified grooming key ────────

  it("writeCuratorConfig({enabled}) writes the unified grooming key", () => {
    const { store } = s!;
    writeCuratorConfig(store, { enabled: true });
    expect(store.getSetting(GROOMING_ENABLED_KEY)).toBe("true");
    expect(readCuratorConfig(store).enabled).toBe(true);
  });

  // ── setIntakeEnabled: the intake counterpart of writeCuratorConfig({enabled}) (PR-5a) ──

  it("setIntakeEnabled writes the unified intake key and round-trips via isIntakeEnabled", () => {
    const { store } = s!;
    expect(isIntakeEnabled(store)).toBe(false); // default off

    setIntakeEnabled(store, true);
    expect(store.getSetting(INTAKE_ENABLED_KEY)).toBe("true");
    expect(isIntakeEnabled(store)).toBe(true);

    setIntakeEnabled(store, false);
    expect(store.getSetting(INTAKE_ENABLED_KEY)).toBe("false");
    expect(isIntakeEnabled(store)).toBe(false);
  });

  // ── Debounce seed: the repurposed interval becomes the auto-trigger floor (D-A) ──

  it("seeds curator.grooming.debounce_minutes from the legacy interval_minutes", () => {
    const { store } = s!;
    store.setSetting("curator.interval_minutes", "45"); // an install's existing cadence
    expect(readCuratorConfig(store).debounceMinutes).toBe(60); // not yet migrated → default

    migrateCuratorEnablement(store);

    expect(store.getSetting("curator.grooming.debounce_minutes")).toBe("45");
    expect(readCuratorConfig(store).debounceMinutes).toBe(45);
  });

  it("never clobbers an explicit debounce value, and is idempotent", () => {
    const { store } = s!;
    store.setSetting("curator.interval_minutes", "45");
    writeCuratorConfig(store, { debounceMinutes: 90 }); // user set it explicitly

    migrateCuratorEnablement(store);
    expect(readCuratorConfig(store).debounceMinutes).toBe(90); // preserved

    migrateCuratorEnablement(store); // re-run → no drift
    expect(readCuratorConfig(store).debounceMinutes).toBe(90);
  });

  it("leaves debounce unset (default) on a fresh install with no legacy interval", () => {
    const { store } = s!;
    migrateCuratorEnablement(store);
    expect(store.getSetting("curator.grooming.debounce_minutes")).toBeNull();
    expect(readCuratorConfig(store).debounceMinutes).toBe(60); // default
  });
});

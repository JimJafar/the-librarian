// Server auto-update NON-LLM configuration (spec 2026-06-16-server-autoupdate T1)
// over the settings store: the enablement flag (`server.autoupdate.enabled`), the
// cadence (`server.autoupdate.cadence`, daily|weekly), and the last-run timestamp
// (`server.autoupdate.last_run_at`). All plain settings — read paths work without
// the master key (the dashboard render + the host wrapper read). The load-bearing
// piece is `isAutoUpdateDue`: enabled AND cadence elapsed since last_run_at, with
// never-run → due and disabled → never due (mirrors the intake sweep's due-check).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  createLibrarianStore,
  DEFAULT_AUTOUPDATE_CADENCE,
  isAutoUpdateDue,
  isAutoUpdateEnabled,
  readAutoUpdateCadence,
  readLastAutoUpdateAt,
  setAutoUpdateCadence,
  setAutoUpdateEnabled,
  writeLastAutoUpdateAt,
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-autoupdate-cfg-"));
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

describe("server auto-update enablement (server.autoupdate.enabled)", () => {
  let s: Scope | null = null;
  beforeEach(() => {
    s = scope();
  });
  afterEach(() => {
    teardown(s);
    s = null;
  });

  it("defaults to disabled (a host never auto-updates until opted in)", () => {
    expect(isAutoUpdateEnabled(s!.store)).toBe(false);
  });

  it("round-trips the enablement toggle as the canonical true/false string", () => {
    const { store } = s!;
    setAutoUpdateEnabled(store, true);
    expect(isAutoUpdateEnabled(store)).toBe(true);
    expect(store.getSetting("server.autoupdate.enabled")).toBe("true");

    setAutoUpdateEnabled(store, false);
    expect(isAutoUpdateEnabled(store)).toBe(false);
    expect(store.getSetting("server.autoupdate.enabled")).toBe("false");
  });

  it("reads enablement WITHOUT the master key (dashboard render path)", () => {
    const { store, dataDir } = s!;
    setAutoUpdateEnabled(store, true);
    store.close();
    const noKey = open(dataDir);
    s!.store = noKey;
    expect(isAutoUpdateEnabled(noKey)).toBe(true);
  });
});

describe("server auto-update cadence (server.autoupdate.cadence)", () => {
  let s: Scope | null = null;
  beforeEach(() => {
    s = scope();
  });
  afterEach(() => {
    teardown(s);
    s = null;
  });

  it("defaults the cadence to daily", () => {
    expect(readAutoUpdateCadence(s!.store)).toBe("daily");
    expect(DEFAULT_AUTOUPDATE_CADENCE).toBe("daily");
  });

  it("round-trips daily and weekly under server.autoupdate.cadence", () => {
    const { store } = s!;
    setAutoUpdateCadence(store, "weekly");
    expect(readAutoUpdateCadence(store)).toBe("weekly");
    expect(store.getSetting("server.autoupdate.cadence")).toBe("weekly");

    setAutoUpdateCadence(store, "daily");
    expect(readAutoUpdateCadence(store)).toBe("daily");
  });

  it("rejects an unknown cadence with a teaching error", () => {
    const { store } = s!;
    expect(() => setAutoUpdateCadence(store, "hourly")).toThrow(/cadence must be one of/i);
    expect(() => setAutoUpdateCadence(store, "")).toThrow(/cadence must be one of/i);
  });

  it("defaults a corrupt stored cadence to daily rather than failing", () => {
    const { store } = s!;
    store.setSetting("server.autoupdate.cadence", "garbage");
    expect(readAutoUpdateCadence(store)).toBe("daily");
  });
});

describe("server auto-update last-run timestamp (server.autoupdate.last_run_at)", () => {
  let s: Scope | null = null;
  beforeEach(() => {
    s = scope();
  });
  afterEach(() => {
    teardown(s);
    s = null;
  });

  it("reads null when no auto-update has ever run", () => {
    expect(readLastAutoUpdateAt(s!.store)).toBeNull();
  });

  it("round-trips an ISO-8601 timestamp under server.autoupdate.last_run_at", () => {
    const { store } = s!;
    const at = new Date("2026-06-01T12:00:00.000Z");
    writeLastAutoUpdateAt(store, at);
    expect(readLastAutoUpdateAt(store)?.toISOString()).toBe(at.toISOString());
    expect(store.getSetting("server.autoupdate.last_run_at")).toBe(at.toISOString());
  });

  it("treats a corrupt stored value as never-run (null) rather than wedging", () => {
    const { store } = s!;
    store.setSetting("server.autoupdate.last_run_at", "not-a-date");
    expect(readLastAutoUpdateAt(store)).toBeNull();
  });
});

describe("isAutoUpdateDue — enabled AND cadence elapsed since last_run_at", () => {
  let s: Scope | null = null;
  beforeEach(() => {
    s = scope();
  });
  afterEach(() => {
    teardown(s);
    s = null;
  });

  const now = new Date("2026-06-16T03:00:00.000Z");
  const hoursAgo = (h: number): Date => new Date(now.getTime() - h * 60 * 60 * 1000);

  it("is NOT due when auto-update is disabled (even with no last run)", () => {
    // Disabled is the gate the wrapper checks first — it never updates, regardless
    // of how long it's been (the timer fires but the wrapper no-ops + logs a skip).
    expect(isAutoUpdateDue(s!.store, now)).toBe(false);
  });

  it("is NOT due when disabled even if the last run was long ago", () => {
    const { store } = s!;
    setAutoUpdateEnabled(store, false);
    setAutoUpdateCadence(store, "daily");
    writeLastAutoUpdateAt(store, hoursAgo(72));
    expect(isAutoUpdateDue(store, now)).toBe(false);
  });

  it("is due when enabled and never run (a freshly-enabled host updates first fire)", () => {
    const { store } = s!;
    setAutoUpdateEnabled(store, true);
    expect(readLastAutoUpdateAt(store)).toBeNull();
    expect(isAutoUpdateDue(store, now)).toBe(true);
  });

  it("daily: due when >= 24h have elapsed, not due before", () => {
    const { store } = s!;
    setAutoUpdateEnabled(store, true);
    setAutoUpdateCadence(store, "daily");

    writeLastAutoUpdateAt(store, hoursAgo(23));
    expect(isAutoUpdateDue(store, now)).toBe(false);

    writeLastAutoUpdateAt(store, hoursAgo(24));
    expect(isAutoUpdateDue(store, now)).toBe(true);

    writeLastAutoUpdateAt(store, hoursAgo(25));
    expect(isAutoUpdateDue(store, now)).toBe(true);
  });

  it("weekly: due when >= 7 days have elapsed, not due at 6 days", () => {
    const { store } = s!;
    setAutoUpdateEnabled(store, true);
    setAutoUpdateCadence(store, "weekly");

    writeLastAutoUpdateAt(store, hoursAgo(6 * 24));
    expect(isAutoUpdateDue(store, now)).toBe(false);

    writeLastAutoUpdateAt(store, hoursAgo(7 * 24));
    expect(isAutoUpdateDue(store, now)).toBe(true);
  });

  it("a daily-due run is NOT yet weekly-due (cadence governs the window)", () => {
    const { store } = s!;
    setAutoUpdateEnabled(store, true);
    writeLastAutoUpdateAt(store, hoursAgo(48)); // 2 days ago

    setAutoUpdateCadence(store, "daily");
    expect(isAutoUpdateDue(store, now)).toBe(true);

    setAutoUpdateCadence(store, "weekly");
    expect(isAutoUpdateDue(store, now)).toBe(false);
  });
});

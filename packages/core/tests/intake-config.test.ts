// Intake (job 1) NON-LLM configuration (spec 045 D-3/D-8) over the settings store.
// The inbox-sweep cadence (`curator.intake.interval_minutes`) and the last-sweep
// timestamp (`curator.intake.last_sweep_at`). Split out of the old shared
// curator-config test alongside the `intake-config.ts` source split (plan 046 R2).
// `readIntakeInterval` reads plain settings only, so it always works without the
// master key (the cockpit render path).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  createLibrarianStore,
  readIntakeInterval,
  readLastIntakeSweepAt,
  writeIntakeInterval,
  writeLastIntakeSweepAt,
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-intake-cfg-"));
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

// ── Intake sweep cadence (spec 045 D-3/D-8): curator.intake.interval_minutes ────
// The inbox-sweep poll interval. New in plan 046 T2; the scheduler wires it in T7.
describe("intake interval config (spec 045 D-3)", () => {
  let s: Scope | null = null;
  beforeEach(() => {
    s = scope();
  });
  afterEach(() => {
    teardown(s);
    s = null;
  });

  it("defaults the intake sweep cadence to every 5 minutes", () => {
    expect(readIntakeInterval(s!.store).intervalMinutes).toBe(5);
  });

  it("round-trips intake interval_minutes and persists under curator.intake.*", () => {
    const { store } = s!;
    writeIntakeInterval(store, { intervalMinutes: 15 });
    expect(readIntakeInterval(store).intervalMinutes).toBe(15);
    expect(store.getSetting("curator.intake.interval_minutes")).toBe("15");
  });

  it("rejects a zero, negative, or non-integer intake interval (integer >= 1)", () => {
    const { store } = s!;
    expect(() => writeIntakeInterval(store, { intervalMinutes: 0 })).toThrow(
      /interval_minutes must be an integer >= 1/i,
    );
    expect(() => writeIntakeInterval(store, { intervalMinutes: -1 })).toThrow(/interval_minutes/i);
    expect(() => writeIntakeInterval(store, { intervalMinutes: 2.5 })).toThrow(/interval_minutes/i);
  });

  it("reads the intake interval WITHOUT the master key (cockpit render path)", () => {
    const { store, dataDir } = s!;
    writeIntakeInterval(store, { intervalMinutes: 10 });
    store.close();
    const noKey = open(dataDir);
    s!.store = noKey;
    expect(readIntakeInterval(noKey).intervalMinutes).toBe(10);
  });
});

describe("intake last-sweep timestamp (plan 046 T7)", () => {
  let s: Scope | null = null;
  beforeEach(() => {
    s = scope();
  });
  afterEach(() => {
    teardown(s);
    s = null;
  });

  it("reads null when no sweep has ever run", () => {
    expect(readLastIntakeSweepAt(s!.store)).toBeNull();
  });

  it("round-trips an ISO-8601 sweep timestamp under curator.intake.last_sweep_at", () => {
    const { store } = s!;
    const at = new Date("2025-06-01T12:00:00.000Z");
    writeLastIntakeSweepAt(store, at);
    expect(readLastIntakeSweepAt(store)?.toISOString()).toBe(at.toISOString());
    expect(store.getSetting("curator.intake.last_sweep_at")).toBe(at.toISOString());
  });

  it("treats a corrupt stored value as never-swept (null) rather than wedging", () => {
    const { store } = s!;
    store.setSetting("curator.intake.last_sweep_at", "not-a-date");
    expect(readLastIntakeSweepAt(store)).toBeNull();
  });
});

// Curator configuration (memory-curator spec §7.1) over the settings store.
//
// Operator-managed NON-LLM config: enable flag, prompt addendum, auto-apply
// posture, schedule. The LLM connection no longer lives here — providers are
// named + dashboard-managed and each consumer picks its own (see
// curator-consumers.test.ts). `readCuratorConfig` reads plain settings only, so
// it always works without the master key.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  createLibrarianStore,
  findLegacyScheduleKeys,
  readCuratorConfig,
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-curator-cfg-"));
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

describe("curator config", () => {
  let s: Scope | null = null;
  beforeEach(() => {
    s = scope();
  });
  afterEach(() => {
    teardown(s);
    s = null;
  });

  it("returns safe defaults when nothing is configured", () => {
    const cfg = readCuratorConfig(s!.store);
    expect(cfg.enabled).toBe(false);
    expect(cfg.defaultAutoApply).toBe("safe_only");
    expect(cfg.autoApplyConfidence).toBeCloseTo(0.9);
    expect(cfg.intervalMinutes).toBe(60);
    // Post-intake trigger defaults (spec 043 D-A): a 20-op threshold + a 60-min
    // debounce floor (the repurposed interval default).
    expect(cfg.triggerThreshold).toBe(20);
    expect(cfg.debounceMinutes).toBe(60);
  });

  it("round-trips trigger_threshold and rejects invalid values (≥ 1 integer)", () => {
    const { store } = s!;
    writeCuratorConfig(store, { triggerThreshold: 5 });
    expect(readCuratorConfig(store).triggerThreshold).toBe(5);
    expect(() => writeCuratorConfig(store, { triggerThreshold: 0 })).toThrow(/threshold/i);
    expect(() => writeCuratorConfig(store, { triggerThreshold: -1 })).toThrow(/threshold/i);
    expect(() => writeCuratorConfig(store, { triggerThreshold: 2.5 })).toThrow(/threshold/i);
  });

  it("round-trips debounce_minutes and clamps invalid values (1..one week)", () => {
    const { store } = s!;
    writeCuratorConfig(store, { debounceMinutes: 30 });
    expect(readCuratorConfig(store).debounceMinutes).toBe(30);
    expect(() => writeCuratorConfig(store, { debounceMinutes: 0 })).toThrow(/debounce/i);
    expect(() => writeCuratorConfig(store, { debounceMinutes: 10 * 24 * 60 })).toThrow(/debounce/i);
    expect(() => writeCuratorConfig(store, { debounceMinutes: 1.5 })).toThrow(/debounce/i);
  });

  it("round-trips the non-LLM curator config", () => {
    const { store } = s!;
    writeCuratorConfig(store, {
      enabled: true,
      promptAddendum: "prefer merging over archiving",
      defaultAutoApply: "high_confidence",
    });
    const cfg = readCuratorConfig(store);
    expect(cfg.enabled).toBe(true);
    expect(cfg.defaultAutoApply).toBe("high_confidence");
    expect(cfg.promptAddendum).toBe("prefer merging over archiving");
  });

  it("reads the config WITHOUT the master key (cockpit render path)", () => {
    const { store, dataDir } = s!;
    writeCuratorConfig(store, { enabled: true, promptAddendum: "x" });
    store.close();
    const noKey = open(dataDir);
    s!.store = noKey;
    const cfg = readCuratorConfig(noKey); // plain settings only — must not need the key
    expect(cfg.enabled).toBe(true);
    expect(cfg.promptAddendum).toBe("x");
  });

  it("validates the prompt addendum length (≤ 2 KB)", () => {
    const { store } = s!;
    expect(() => writeCuratorConfig(store, { promptAddendum: "x".repeat(2049) })).toThrow(/2/);
  });

  it("round-trips intervalMinutes and clamps invalid values", () => {
    const { store } = s!;
    expect(readCuratorConfig(store).intervalMinutes).toBe(60);
    writeCuratorConfig(store, { intervalMinutes: 15 });
    expect(readCuratorConfig(store).intervalMinutes).toBe(15);
    expect(() => writeCuratorConfig(store, { intervalMinutes: 0 })).toThrow(/interval/i);
    expect(() => writeCuratorConfig(store, { intervalMinutes: 10 * 24 * 60 })).toThrow(/interval/i);
    expect(() => writeCuratorConfig(store, { intervalMinutes: 5.5 })).toThrow(/interval/i);
  });

  it("findLegacyScheduleKeys reports each legacy schedule key still in settings", () => {
    const { store } = s!;
    expect(findLegacyScheduleKeys(store)).toEqual([]);
    store.setSetting("curator.schedule.interval_days", "1");
    store.setSetting("curator.schedule.time", "03:00");
    store.setSetting("curator.schedule.min_sessions_since_run", "10");
    expect(findLegacyScheduleKeys(store)).toEqual([
      "curator.schedule.interval_days",
      "curator.schedule.time",
      "curator.schedule.min_sessions_since_run",
    ]);
  });

  it("validates default_auto_apply and confidence bounds", () => {
    const { store } = s!;
    expect(() =>
      writeCuratorConfig(store, {
        defaultAutoApply: "yolo" as unknown as "off",
      }),
    ).toThrow(/auto_apply|auto-apply/i);
    expect(() => writeCuratorConfig(store, { autoApplyConfidence: 1.5 })).toThrow(/confidence/i);
    expect(() => writeCuratorConfig(store, { autoApplyConfidence: -0.1 })).toThrow(/confidence/i);
  });
});

// Curator pause tests (rethink T21, spec §8 / D16). The whole-vault restore
// pauses BOTH curator jobs through a dedicated signal — never the operator's
// curator.*.enabled settings — checked first thing by runIntakeTick and
// runGroomingTick (run-now's allowDisabled override included). The signal is
// in-process + a TTL-bounded settings stamp, so a crashed restore can never
// wedge the curator off forever.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CURATOR_PAUSE_KEY,
  CURATOR_PAUSE_TTL_MS,
  type LibrarianStore,
  createLibrarianStore,
  isCuratorPausedForRestore,
  pauseCuratorForRestore,
  resumeCuratorAfterRestore,
  runGroomingTick,
  runIntakeTick,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dataDir: string;
let store: LibrarianStore;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-pause-"));
  store = createLibrarianStore({ dataDir });
});

afterEach(() => {
  resumeCuratorAfterRestore(store); // never leak the in-process flag across tests
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("pause signal", () => {
  it("pauses and resumes through the in-process flag + settings stamp", () => {
    expect(isCuratorPausedForRestore(store)).toBe(false);
    pauseCuratorForRestore(store);
    expect(isCuratorPausedForRestore(store)).toBe(true);
    expect(store.getSetting(CURATOR_PAUSE_KEY)).toMatch(/^\d{4}-/);
    resumeCuratorAfterRestore(store);
    expect(isCuratorPausedForRestore(store)).toBe(false);
    expect(store.getSetting(CURATOR_PAUSE_KEY)).toBeNull();
  });

  it("a stale stamp (crashed restore) self-heals after the TTL — cross-process view", () => {
    const pausedAt = new Date("2026-06-12T10:00:00.000Z");
    // Another process paused (settings stamp only — no in-process flag here).
    store.setSetting(CURATOR_PAUSE_KEY, pausedAt.toISOString());
    const during = new Date(pausedAt.getTime() + CURATOR_PAUSE_TTL_MS - 1000);
    const after = new Date(pausedAt.getTime() + CURATOR_PAUSE_TTL_MS + 1000);
    expect(isCuratorPausedForRestore(store, during)).toBe(true);
    expect(isCuratorPausedForRestore(store, after)).toBe(false);
  });

  it("an unreadable stamp never wedges the curator", () => {
    store.setSetting(CURATOR_PAUSE_KEY, "not a timestamp");
    expect(isCuratorPausedForRestore(store)).toBe(false);
  });
});

describe("both ticks observe the pause", () => {
  it("runIntakeTick skips with reason 'paused' — even with allowDisabled (run-now)", async () => {
    pauseCuratorForRestore(store);
    expect(await runIntakeTick({ store })).toEqual({ ran: false, reason: "paused" });
    expect(await runIntakeTick({ store, allowDisabled: true })).toEqual({
      ran: false,
      reason: "paused",
    });
  });

  it("runGroomingTick skips with reason 'paused' — even with allowDisabled (run-now)", async () => {
    pauseCuratorForRestore(store);
    expect(await runGroomingTick({ store })).toEqual({ ran: false, reason: "paused" });
    expect(await runGroomingTick({ store, allowDisabled: true })).toEqual({
      ran: false,
      reason: "paused",
    });
  });

  it("after resume the ticks fall through to their normal gates (not 'paused')", async () => {
    pauseCuratorForRestore(store);
    resumeCuratorAfterRestore(store);
    const intake = await runIntakeTick({ store });
    const grooming = await runGroomingTick({ store });
    expect(intake).toMatchObject({ ran: false });
    expect(grooming).toMatchObject({ ran: false });
    expect((intake as { reason: string }).reason).not.toBe("paused");
    expect((grooming as { reason: string }).reason).not.toBe("paused");
  });
});

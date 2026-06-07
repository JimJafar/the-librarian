// Scheduled grooming entry (spec 045 D-3, plan 046 T6). The boot scheduler (T7)
// polls this on a fixed internal cadence; it self-gates on enabled, consults the
// wall-clock schedule (`isScheduleDue`) and the LAST SCHEDULED-PASS timestamp, and
// runs a full pass only when due — stamping the timestamp on a completed pass so
// the next due-check works. The pass runner is injected (a fake) so these tests
// are network-free and deterministic via an injected `now`.
//
// Key invariant under test: the scheduled timestamp is owned by SCHEDULED passes
// ONLY — the post-intake trigger and run-now must never touch it, so the nightly
// cadence stays predictable regardless of ad-hoc grooms.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LAST_SCHEDULED_GROOM_KEY,
  type LibrarianStore,
  createLibrarianStore,
  maybeTriggerGroomingAfterIntake,
  runScheduledGrooming,
  writeGroomingConfig,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let store: LibrarianStore | null = null;
let dataDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-sched-groom-"));
  store = createLibrarianStore({ dataDir });
});
afterEach(() => {
  try {
    store?.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
  store = null;
});

// A fake pass runner standing in for runGroomingTick: records the `now` it was given
// and returns a configurable result so we can prove the schedule gate decides
// WHETHER the pass runs without needing a real LLM connection.
function fakePass(result: { ran: true } | { ran: false; reason: string } = { ran: true }) {
  const calls: Array<{ now: Date }> = [];
  const fn = vi.fn(async (_store: LibrarianStore, now: Date) => {
    calls.push({ now });
    return result as never;
  });
  return { fn, calls };
}

describe("runScheduledGrooming — enable gate", () => {
  it("does nothing when grooming is disabled (the default)", async () => {
    const pass = fakePass();
    const result = await runScheduledGrooming({
      store: store!,
      now: new Date(2026, 5, 7, 3, 0, 0), // local 03:00 — would be due if enabled
      runPass: pass.fn,
    });
    expect(result).toEqual({ ran: false, reason: "disabled" });
    expect(pass.fn).not.toHaveBeenCalled();
    expect(store!.getSetting(LAST_SCHEDULED_GROOM_KEY)).toBeNull();
  });

  it("runs a disabled-but-due job when allowDisabled is set (the run-now seam)", async () => {
    const pass = fakePass({ ran: true });
    const result = await runScheduledGrooming({
      store: store!,
      now: new Date(2026, 5, 7, 3, 0, 0),
      allowDisabled: true,
      runPass: pass.fn,
    });
    expect(result).toEqual({ ran: true });
    expect(pass.fn).toHaveBeenCalledTimes(1);
  });
});

describe("runScheduledGrooming — schedule gate (enabled)", () => {
  beforeEach(() => {
    // Enabled, default schedule = every 1 day at 03:00 local.
    writeGroomingConfig(store!, { enabled: true });
  });

  it("runs a pass and stamps the timestamp when due (never-run, past 03:00)", async () => {
    const pass = fakePass({ ran: true });
    const now = new Date(2026, 5, 7, 3, 30, 0); // local 03:30 — past today's 03:00 fire
    const result = await runScheduledGrooming({ store: store!, now, runPass: pass.fn });

    expect(result).toEqual({ ran: true });
    expect(pass.fn).toHaveBeenCalledTimes(1);
    // The schedule's evaluation `now` is forwarded to the pass runner.
    expect(pass.calls[0]?.now).toEqual(now);
    // The completed pass stamped the scheduled-run timestamp = `now`.
    expect(store!.getSetting(LAST_SCHEDULED_GROOM_KEY)).toBe(now.toISOString());
  });

  it("does NOT run and does NOT stamp when not due (before today's 03:00, never run)", async () => {
    const pass = fakePass({ ran: true });
    const now = new Date(2026, 5, 7, 2, 0, 0); // local 02:00 — before today's 03:00
    const result = await runScheduledGrooming({ store: store!, now, runPass: pass.fn });

    expect(result).toEqual({ ran: false, reason: "not_due" });
    expect(pass.fn).not.toHaveBeenCalled();
    expect(store!.getSetting(LAST_SCHEDULED_GROOM_KEY)).toBeNull();
  });

  it("does NOT run when the last scheduled pass was this window (already groomed today)", async () => {
    // Stamp a scheduled run earlier today; the next fire is tomorrow at 03:00.
    const lastRun = new Date(2026, 5, 7, 3, 5, 0);
    store!.setSetting(LAST_SCHEDULED_GROOM_KEY, lastRun.toISOString());
    const pass = fakePass({ ran: true });
    const now = new Date(2026, 5, 7, 23, 59, 0); // later the same day
    const result = await runScheduledGrooming({ store: store!, now, runPass: pass.fn });

    expect(result).toEqual({ ran: false, reason: "not_due" });
    expect(pass.fn).not.toHaveBeenCalled();
    // The timestamp is unchanged by a not-due poll.
    expect(store!.getSetting(LAST_SCHEDULED_GROOM_KEY)).toBe(lastRun.toISOString());
  });

  it("runs again once the next window opens (a day later at 03:00)", async () => {
    const lastRun = new Date(2026, 5, 7, 3, 5, 0);
    store!.setSetting(LAST_SCHEDULED_GROOM_KEY, lastRun.toISOString());
    const pass = fakePass({ ran: true });
    const now = new Date(2026, 5, 8, 3, 0, 0); // next day at 03:00
    const result = await runScheduledGrooming({ store: store!, now, runPass: pass.fn });

    expect(result).toEqual({ ran: true });
    expect(pass.fn).toHaveBeenCalledTimes(1);
    expect(store!.getSetting(LAST_SCHEDULED_GROOM_KEY)).toBe(now.toISOString());
  });

  it("does NOT stamp when the due pass could not complete (pass returned ran:false)", async () => {
    // Due, but the underlying pass can't run (e.g. incomplete LLM config). The
    // schedule must NOT advance — the next poll should retry once the config is fixed.
    const pass = fakePass({ ran: false, reason: "incomplete_config" });
    const now = new Date(2026, 5, 7, 3, 30, 0);
    const result = await runScheduledGrooming({ store: store!, now, runPass: pass.fn });

    expect(result).toEqual({ ran: false, reason: "incomplete_config" });
    expect(pass.fn).toHaveBeenCalledTimes(1);
    expect(store!.getSetting(LAST_SCHEDULED_GROOM_KEY)).toBeNull();
  });

  it("honours a custom interval (every 7 days = weekly)", async () => {
    writeGroomingConfig(store!, { intervalDays: 7 });
    const lastRun = new Date(2026, 5, 1, 3, 0, 0);
    store!.setSetting(LAST_SCHEDULED_GROOM_KEY, lastRun.toISOString());
    const pass = fakePass({ ran: true });

    // 6 days later → not due yet.
    const sixDays = await runScheduledGrooming({
      store: store!,
      now: new Date(2026, 5, 7, 3, 0, 0),
      runPass: pass.fn,
    });
    expect(sixDays).toEqual({ ran: false, reason: "not_due" });

    // 7 days later → due.
    const sevenDays = await runScheduledGrooming({
      store: store!,
      now: new Date(2026, 5, 8, 3, 0, 0),
      runPass: pass.fn,
    });
    expect(sevenDays).toEqual({ ran: true });
    expect(pass.fn).toHaveBeenCalledTimes(1);
  });
});

describe("scheduled timestamp ownership — only scheduled passes advance it", () => {
  it("the post-intake trigger runs a groom but does NOT touch the scheduled timestamp", async () => {
    writeGroomingConfig(store!, { enabled: true, triggerThreshold: 1 });
    // Force the trigger to fire by injecting an applied-op count via a fake groom
    // runner; the real countAppliedOperationsSince is exercised in its own suite. We
    // assert the post-intake path runs the groom but never stamps the SCHEDULED key.
    const groom = vi.fn(async () => ({ ran: true }));
    // Drive the threshold by stubbing the applied-op count to a value ≥ threshold so
    // the trigger arms; the real countAppliedOperationsSince is exercised in its own
    // suite. We assert the post-intake path runs the groom but never stamps the
    // SCHEDULED key.
    store!.countAppliedOperationsSince = (() => 5) as LibrarianStore["countAppliedOperationsSince"];

    const result = await maybeTriggerGroomingAfterIntake({
      store: store!,
      now: new Date(2026, 5, 7, 3, 30, 0),
      runGroom: groom,
    });

    expect(result).toEqual({ triggered: true });
    expect(groom).toHaveBeenCalledTimes(1);
    // The scheduled-pass timestamp is untouched by the post-intake trigger.
    expect(store!.getSetting(LAST_SCHEDULED_GROOM_KEY)).toBeNull();
  });

  it("a post-intake groom does NOT suppress the first scheduled window — the schedule still fires once due", async () => {
    // Documents the intended interaction between the two grooming paths: a
    // post-intake groom does its work but leaves LAST_SCHEDULED_GROOM_KEY null
    // (only a completed SCHEDULED pass stamps it). Because the stamp stays null,
    // isScheduleDue(now, null, …) is still true once now >= today's {time}, so
    // the scheduled entry must still fire its first window even though an ad-hoc
    // groom already ran. If the post-intake groom ever stamped the key, this
    // scheduled pass would be (wrongly) suppressed.
    writeGroomingConfig(store!, { enabled: true, triggerThreshold: 1 });
    store!.countAppliedOperationsSince = (() => 5) as LibrarianStore["countAppliedOperationsSince"];

    // 1) A post-intake groom fires earlier in the day (does NOT stamp the key).
    const intakeGroom = vi.fn(async () => ({ ran: true }));
    const triggerResult = await maybeTriggerGroomingAfterIntake({
      store: store!,
      now: new Date(2026, 5, 7, 1, 0, 0), // local 01:00 — before today's 03:00 fire
      runGroom: intakeGroom,
    });
    expect(triggerResult).toEqual({ triggered: true });
    expect(intakeGroom).toHaveBeenCalledTimes(1);
    expect(store!.getSetting(LAST_SCHEDULED_GROOM_KEY)).toBeNull();

    // 2) Later, past today's 03:00, the SCHEDULED entry is consulted. Because the
    //    stamp is still null, the first scheduled window is still due and runs.
    const scheduledPass = fakePass({ ran: true });
    const now = new Date(2026, 5, 7, 3, 30, 0); // local 03:30 — past today's 03:00 fire
    const scheduledResult = await runScheduledGrooming({
      store: store!,
      now,
      runPass: scheduledPass.fn,
    });

    expect(scheduledResult).toEqual({ ran: true });
    expect(scheduledPass.fn).toHaveBeenCalledTimes(1);
    // Now (and only now) the SCHEDULED pass stamps the key.
    expect(store!.getSetting(LAST_SCHEDULED_GROOM_KEY)).toBe(now.toISOString());
  });
});

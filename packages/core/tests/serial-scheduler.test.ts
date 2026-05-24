// Serial interval runner (spec §14). Verifies the non-overlap guarantee, error
// routing, and start/stop idempotency using fake timers.

import { createSerialScheduler } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A task whose promise resolves only when `release()` is called. */
function deferredTask() {
  let release: () => void = () => {};
  let calls = 0;
  const task = vi.fn(() => {
    calls++;
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  return {
    task,
    release: () => release(),
    get calls() {
      return calls;
    },
  };
}

describe("createSerialScheduler", () => {
  it("fires the task on each interval", async () => {
    const task = vi.fn(async () => {});
    const scheduler = createSerialScheduler({ task, intervalMs: 1000 });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(2);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(task).toHaveBeenCalledTimes(2); // no more after stop
  });

  it("never overlaps — a tick is skipped while the previous is still running", async () => {
    const { task, release } = deferredTask();
    const scheduler = createSerialScheduler({ task, intervalMs: 1000 });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(1000); // tick 1 starts, stays pending
    expect(task).toHaveBeenCalledTimes(1);
    expect(scheduler.isRunning()).toBe(true);

    await vi.advanceTimersByTimeAsync(2000); // two more intervals — both skipped
    expect(task).toHaveBeenCalledTimes(1);

    release(); // tick 1 finishes
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.isRunning()).toBe(false);

    await vi.advanceTimersByTimeAsync(1000); // next interval now runs
    expect(task).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("routes a task error to onError without stopping the schedule", async () => {
    const onError = vi.fn();
    let attempt = 0;
    const task = vi.fn(async () => {
      attempt++;
      if (attempt === 1) throw new Error("boom");
    });
    const scheduler = createSerialScheduler({ task, intervalMs: 1000, onError });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000); // schedule survives the error
    expect(task).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("start is idempotent (a second start does not double-schedule)", async () => {
    const task = vi.fn(async () => {});
    const scheduler = createSerialScheduler({ task, intervalMs: 1000 });
    scheduler.start();
    scheduler.start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(1); // not 2
    scheduler.stop();
  });
});

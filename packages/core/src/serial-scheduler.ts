// A minimal serial interval runner (spec §14: the curator scheduler "must run
// serially" so a live run is never reclaimed mid-flight). Fires `task` every
// `intervalMs`, but NEVER overlaps — if a tick is still in flight when the timer
// fires, that tick is skipped. Errors are routed to `onError` (never thrown out
// of the timer). The internal timer is unref'd so it doesn't keep the process
// alive on its own.

export interface SerialScheduler {
  start(): void;
  stop(): void;
  /** True while a tick is in flight (exposed for tests/observability). */
  isRunning(): boolean;
  /**
   * Run the task ONCE right now, THROUGH the same in-flight guard the timer uses —
   * so an explicit run (e.g. a boot scan) can NEVER overlap a scheduled tick (or
   * another runNow). If a tick is already in flight this is a no-op. Resolves when
   * the run it triggered (or skipped) is done; errors route to `onError`, never
   * thrown. This is the guard-sharing entry point for one-shot kicks that must not
   * race the periodic ticks.
   */
  runNow(): Promise<void>;
}

export interface SerialSchedulerOptions {
  task: () => Promise<unknown>;
  intervalMs: number;
  onError?: (error: unknown) => void;
}

export function createSerialScheduler(options: SerialSchedulerOptions): SerialScheduler {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function tick(): Promise<void> {
    if (running) return; // previous tick still in flight — skip, no overlap
    running = true;
    try {
      await options.task();
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return; // idempotent
      timer = setInterval(() => void tick(), options.intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    isRunning: () => running,
    // Share the timer's guard for an explicit one-shot run: if a tick is already
    // in flight, skip (same semantics as an overlapping timer fire); otherwise run
    // the task to completion under the guard so no tick can start during it.
    runNow: () => tick(),
  };
}

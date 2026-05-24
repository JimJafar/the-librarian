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
  };
}

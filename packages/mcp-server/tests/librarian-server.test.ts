// createLibrarianServer composition root — handle shape + scheduler lifecycle
// (spec 060 T2, SC 1 + SC 3).
//
// SC 1 (handle shape) is asserted against the real factory on a temp data dir,
// without binding listeners (start() is never called). SC 3 (scheduler
// semantics, BOTH directions) is asserted against the load-bearing ordering
// functions the factory's handle delegates to — startRuntime / stopRuntime —
// driven with instrumented fakes:
//
//   - start(): the internal listener binds first, then the public one, then
//     every scheduler starts exactly ONCE, inside the public listen callback
//     (i.e. after the public listener is accepting) — same as today's boot.
//   - stop(): schedulers stopped → store.close() → both listeners closed, in
//     that order. A reordering regression flips the recorded order and fails the
//     assertion. The order is load-bearing because a scheduler tick writes
//     through the store: the "reordered shutdown" case proves a tick racing a
//     store that was closed too early throws, and the correct order survives it.
//
// Imports the compiled artifact (../dist), like per-surface-role.test.ts.

import type { SerialScheduler } from "@librarian/core";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../test/helpers.js";
import {
  type LibrarianServerOptions,
  type ServerRuntime,
  createLibrarianServer,
  startRuntime,
  stopRuntime,
} from "../dist/librarian-server.js";

// An instrumented store: close() records + marks it closed; write() throws once
// closed — modelling a scheduler tick that lands on a store closed too early.
interface FakeStore {
  close(): void;
  write(): void;
}

function makeStore(order: string[]): FakeStore {
  let closed = false;
  return {
    close() {
      order.push("store.close");
      closed = true;
    },
    write() {
      if (closed) throw new Error("wrote through a closed store");
    },
  };
}

// An instrumented scheduler: records start/stop, and tick() writes through the
// store ONLY while live — so a tick after stop() is a no-op, but a tick while
// still live against a closed store throws (the hazard the order guards against).
interface FakeScheduler extends SerialScheduler {
  tick(): void;
}

function makeScheduler(name: string, order: string[], store: FakeStore): FakeScheduler {
  let live = false;
  return {
    start() {
      order.push(`${name}.start`);
      live = true;
    },
    stop() {
      order.push(`${name}.stop`);
      live = false;
    },
    isRunning: () => false,
    runNow: () => Promise.resolve(),
    tick() {
      if (live) store.write();
    },
  };
}

// A minimal instrumented listener: listen() records + fires its callback (the
// listener is "accepting"); close() records + reports done.
interface FakeListener {
  listen(port: number, host: string, onListening: () => void): void;
  close(callback: (err?: Error) => void): void;
}

function makeListener(name: string, order: string[]): FakeListener {
  return {
    listen(_port, _host, onListening) {
      order.push(`${name}.listen`);
      onListening();
    },
    close(callback) {
      order.push(`${name}.close`);
      callback();
    },
  };
}

function makeRuntime(
  order: string[],
  schedulers: FakeScheduler[],
  store: FakeStore,
): ServerRuntime {
  return {
    schedulers,
    store,
    publicServer: makeListener("public", order),
    internalServer: makeListener("internal", order),
    publicBind: { port: 3838, host: "127.0.0.1" },
    internalBind: { port: 3840, host: "127.0.0.1" },
    onInternalListening: () => order.push("internal.banner"),
    onPublicListening: () => order.push("public.banner"),
  };
}

const SCHEDULER_NAMES = ["backup", "intake", "grooming", "transcript"] as const;

// The load-bearing shutdown order, exercised in both directions with the same
// fakes: the correct order (schedulers stopped, THEN store closed) survives a
// racing tick; the reordered one lets the tick write through a closed store.
function simulateShutdown(reordered: boolean): void {
  const order: string[] = [];
  const store = makeStore(order);
  const scheduler = makeScheduler("intake", order, store);
  scheduler.start(); // live, as it is at runtime

  if (reordered) {
    // WRONG: the store is closed while the scheduler is still live, so a tick
    // racing the shutdown lands on a closed store.
    store.close();
    scheduler.tick();
    scheduler.stop();
  } else {
    // The order stopRuntime enforces: halt the scheduler first, so a racing tick
    // is a no-op before the store closes.
    scheduler.stop();
    scheduler.tick();
    store.close();
  }
}

// Base options with every scheduler timer OFF (no schedulers created, no boot
// scan) so the handle-shape assertions need never bind a listener.
function baseOptions(dataDir: string): LibrarianServerOptions {
  return {
    dataDir,
    secretKey: null,
    host: "127.0.0.1",
    port: 0,
    trpcHost: "127.0.0.1",
    trpcPort: 0,
    adminToken: "",
    agentToken: "",
    agentTokenMap: new Map(),
    allowedOrigins: [],
    allowNoAuth: true,
    maxBodyBytes: 1024 * 1024,
    backupTickMs: 0,
    intakePollMs: 0,
    groomingPollMs: 0,
    transcriptSweepTickMs: 0,
  };
}

describe("createLibrarianServer — handle shape (spec 060 SC 1)", () => {
  it("returns a { start, stop, store, internals } handle", () => {
    const dataDir = makeTempDir();
    try {
      const server = createLibrarianServer(baseOptions(dataDir));
      try {
        expect(typeof server.start).toBe("function");
        expect(typeof server.stop).toBe("function");
        expect(server.store).toBeDefined();
        // internals is the non-API seam; every timer disabled ⇒ no schedulers.
        expect(server.internals.schedulers).toEqual([]);
      } finally {
        server.store.close();
      }
    } finally {
      cleanupTempDir(dataDir);
    }
  });

  it("internals.schedulers lists exactly the enabled schedulers", () => {
    const dataDir = makeTempDir();
    try {
      // Only the backup timer is > 0 ⇒ exactly one live scheduler.
      const server = createLibrarianServer({ ...baseOptions(dataDir), backupTickMs: 60_000 });
      try {
        expect(server.internals.schedulers.length).toBe(1);
      } finally {
        server.store.close();
      }
    } finally {
      cleanupTempDir(dataDir);
    }
  });
});

describe("server lifecycle order (spec 060 SC 3)", () => {
  it("start() binds internal, then public, then starts every scheduler exactly once after the public listener is accepting", () => {
    const order: string[] = [];
    const store = makeStore(order);
    const schedulers = SCHEDULER_NAMES.map((name) => makeScheduler(name, order, store));

    startRuntime(makeRuntime(order, schedulers, store));

    expect(order).toEqual([
      "internal.listen",
      "internal.banner",
      "public.listen",
      "backup.start",
      "intake.start",
      "grooming.start",
      "transcript.start",
      "public.banner",
    ]);
    // Exactly once each: a double start(), or a start outside the public listen
    // callback, would show up as a duplicate or a misordered entry above.
    for (const name of SCHEDULER_NAMES) {
      expect(order.filter((entry) => entry === `${name}.start`).length).toBe(1);
    }
  });

  it("stop() stops every scheduler, THEN closes the store, THEN closes both listeners", async () => {
    const order: string[] = [];
    const store = makeStore(order);
    const schedulers = SCHEDULER_NAMES.map((name) => makeScheduler(name, order, store));
    const runtime = makeRuntime(order, schedulers, store);
    // Bring them up first so a stray post-close tick would be a real hazard.
    for (const scheduler of schedulers) scheduler.start();
    order.length = 0;

    await stopRuntime(runtime);

    expect(order).toEqual([
      "backup.stop",
      "intake.stop",
      "grooming.stop",
      "transcript.stop",
      "store.close",
      "public.close",
      "internal.close",
    ]);
  });

  it("the correct shutdown order (schedulers before the store) survives a racing tick", () => {
    expect(() => simulateShutdown(false)).not.toThrow();
  });

  it("a reordered shutdown (store before schedulers) lets a tick write through a closed store", () => {
    expect(() => simulateShutdown(true)).toThrow("wrote through a closed store");
  });
});

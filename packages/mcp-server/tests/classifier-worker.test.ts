// Classifier worker — state-machine tests against the real
// `@librarian/core` store. Using the production store (rather than a
// raw `node:sqlite` handle) keeps the DDL canonical and avoids Vite's
// `node:`-prefix-mangling on the SSR transform.
//
// The worker is wired but inert in production (Section 4a); these
// tests exercise it through `processOnce()` so we don't depend on the
// runtime polling loop.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Classifier, ClassifyResult } from "@librarian/classifier";
import { createLibrarianStore, type LibrarianStore } from "@librarian/core";
import { createClassifierWorker } from "@librarian/mcp-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface EventLog {
  event_type: string;
  memory_id: string | null;
  agent_id: string | null;
  payload: Record<string, unknown>;
}

function setupStore(): { store: LibrarianStore; dataDir: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-classifier-worker-"));
  const store = createLibrarianStore({ dataDir });
  return { store, dataDir };
}

function cleanupStore(store: LibrarianStore, dataDir: string): void {
  try {
    store.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
}

function insertMemory(
  store: LibrarianStore,
  id: string,
  overrides: { tags?: string[]; agent_id?: string; created_at?: string } = {},
): void {
  // Use the production createMemory path to get a row with all the
  // NOT NULL columns populated correctly, then override the id +
  // created_at + tags. `pendingClassification: true` lands the row at
  // `classified=0` so the worker picks it up — that's the cutover
  // contract from plan Section 4d.
  const { memory } = store.createMemory(
    {
      agent_id: overrides.agent_id ?? "codex",
      title: `title-${id}`,
      body: `body-${id}`,
      category: "tools",
      visibility: "common",
      scope: "tool",
      tags: overrides.tags ?? [],
    },
    { pendingClassification: true },
  );
  // Pin the id + created_at so tests can pre-seed the queue order.
  store.db
    .prepare("UPDATE memories SET id = ?, created_at = ? WHERE id = ?")
    .run(id, overrides.created_at ?? "2026-01-01T00:00:00Z", memory.id);
}

function fakeAppendEvent(): {
  fn: (
    eventType: string,
    payload: Record<string, unknown>,
    options?: { memory_id?: string; agent_id?: string },
  ) => void;
  events: EventLog[];
} {
  const events: EventLog[] = [];
  return {
    events,
    fn(eventType, payload, options = {}) {
      events.push({
        event_type: eventType,
        memory_id: options.memory_id ?? null,
        agent_id: options.agent_id ?? null,
        payload,
      });
    },
  };
}

const SUCCESS: ClassifyResult = {
  verdict: { requires_approval: false, is_global: true },
  prompt_version: "v1",
  provider: "remote",
  model: "gpt-4o-mini",
  latency_ms: 12,
  raw_output: '{"requires_approval": false, "is_global": true}',
};

const PARSE_FAILURE: ClassifyResult = {
  verdict: { requires_approval: true, is_global: false },
  fallback_used: "parse",
  prompt_version: "v1",
  provider: "remote",
  model: "gpt-4o-mini",
  latency_ms: 5,
  raw_output: "I cannot classify this.",
};

describe("classifier-worker.processOnce", () => {
  let store: LibrarianStore;
  let dataDir: string;

  beforeEach(() => {
    ({ store, dataDir } = setupStore());
  });

  afterEach(() => {
    cleanupStore(store, dataDir);
  });

  it("returns idle when no memories are pending", async () => {
    const { fn } = fakeAppendEvent();
    const worker = createClassifierWorker({
      db: store.db,
      classifier: {
        async classify() {
          return SUCCESS;
        },
      },
      appendEvent: fn,
    });
    expect(await worker.processOnce()).toBe("idle");
  });

  it("classifies the oldest pending row first (created_at ORDER BY)", async () => {
    insertMemory(store, "mem-new", { created_at: "2026-02-01T00:00:00Z" });
    insertMemory(store, "mem-old", { created_at: "2026-01-01T00:00:00Z" });
    const seen: string[] = [];
    const classifier: Classifier = {
      async classify(input) {
        seen.push(input.title);
        return SUCCESS;
      },
    };
    const { fn } = fakeAppendEvent();
    const worker = createClassifierWorker({ db: store.db, classifier, appendEvent: fn });
    expect(await worker.processOnce()).toBe("processed");
    expect(seen).toEqual(["title-mem-old"]);
  });

  it("on success: writes the verdict, flips classified=1, emits memory.classified", async () => {
    insertMemory(store, "mem-1", { tags: ["identity"] });
    const { fn, events } = fakeAppendEvent();
    const worker = createClassifierWorker({
      db: store.db,
      classifier: {
        async classify() {
          return SUCCESS;
        },
      },
      appendEvent: fn,
    });
    expect(await worker.processOnce()).toBe("processed");
    const row = store.db
      .prepare(
        "SELECT classified, classification_attempts, is_global, requires_approval FROM memories WHERE id = ?",
      )
      .get("mem-1") as {
      classified: number;
      classification_attempts: number;
      is_global: number;
      requires_approval: number;
    };
    expect(row.classified).toBe(1);
    expect(row.classification_attempts).toBe(0);
    expect(row.is_global).toBe(1);
    expect(row.requires_approval).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe("memory.classified");
    expect(events[0]?.memory_id).toBe("mem-1");
    expect(events[0]?.payload).toMatchObject({
      provider: "remote",
      model: "gpt-4o-mini",
      prompt_version: "v1",
      parsed: { requires_approval: false, is_global: true },
      attempt_number: 1,
      input: { title: "title-mem-1", body: "body-mem-1", tags: ["identity"] },
      raw_output: '{"requires_approval": false, "is_global": true}',
    });
    expect(events[0]?.payload.fallback_used).toBeUndefined();
  });

  it("promotes proposed→active when the classifier decides requires_approval=false (Section 4d cutover)", async () => {
    insertMemory(store, "mem-1", { tags: ["tools"] });
    // pendingClassification writes land at status=proposed; confirm
    // that's the starting state.
    const before = store.db.prepare("SELECT status FROM memories WHERE id = ?").get("mem-1") as {
      status: string;
    };
    expect(before.status).toBe("proposed");

    const { fn } = fakeAppendEvent();
    const worker = createClassifierWorker({
      db: store.db,
      classifier: {
        async classify() {
          return SUCCESS; // requires_approval=false
        },
      },
      appendEvent: fn,
    });
    expect(await worker.processOnce()).toBe("processed");
    const after = store.db
      .prepare("SELECT status, classified, requires_approval FROM memories WHERE id = ?")
      .get("mem-1") as { status: string; classified: number; requires_approval: number };
    expect(after.status).toBe("active");
    expect(after.classified).toBe(1);
    expect(after.requires_approval).toBe(0);
  });

  it("does NOT demote an `active` memory even when classifier decides requires_approval=true", async () => {
    insertMemory(store, "mem-1");
    // Operator-side promotion the worker should not undo.
    store.db.prepare("UPDATE memories SET status = 'active' WHERE id = ?").run("mem-1");
    const { fn } = fakeAppendEvent();
    const worker = createClassifierWorker({
      db: store.db,
      classifier: {
        async classify(): Promise<ClassifyResult> {
          return {
            verdict: { requires_approval: true, is_global: false },
            prompt_version: "v1",
            provider: "remote",
            model: "gpt-4o-mini",
            latency_ms: 100,
            raw_output: '{"requires_approval": true, "is_global": false}',
          };
        },
      },
      appendEvent: fn,
    });
    expect(await worker.processOnce()).toBe("processed");
    const row = store.db
      .prepare("SELECT status, classified, requires_approval FROM memories WHERE id = ?")
      .get("mem-1") as { status: string; classified: number; requires_approval: number };
    expect(row.status).toBe("active");
    expect(row.classified).toBe(1);
    expect(row.requires_approval).toBe(1);
  });

  it("does NOT touch an `archived` memory's status when classifier decides requires_approval=false", async () => {
    insertMemory(store, "mem-1");
    store.db.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run("mem-1");
    const { fn } = fakeAppendEvent();
    const worker = createClassifierWorker({
      db: store.db,
      classifier: {
        async classify() {
          return SUCCESS; // requires_approval=false
        },
      },
      appendEvent: fn,
    });
    expect(await worker.processOnce()).toBe("processed");
    const row = store.db.prepare("SELECT status FROM memories WHERE id = ?").get("mem-1") as {
      status: string;
    };
    expect(row.status).toBe("archived");
  });

  it("keeps proposed memories in proposed state when classifier decides requires_approval=true", async () => {
    insertMemory(store, "mem-1", { tags: ["identity"] });
    const { fn } = fakeAppendEvent();
    const worker = createClassifierWorker({
      db: store.db,
      classifier: {
        async classify(): Promise<ClassifyResult> {
          return {
            verdict: { requires_approval: true, is_global: true },
            prompt_version: "v1",
            provider: "remote",
            model: "gpt-4o-mini",
            latency_ms: 100,
            raw_output: '{"requires_approval": true, "is_global": true}',
          };
        },
      },
      appendEvent: fn,
    });
    expect(await worker.processOnce()).toBe("processed");
    const row = store.db
      .prepare("SELECT status, classified, requires_approval FROM memories WHERE id = ?")
      .get("mem-1") as { status: string; classified: number; requires_approval: number };
    expect(row.status).toBe("proposed");
    expect(row.classified).toBe(1);
    expect(row.requires_approval).toBe(1);
  });

  it("on a fallback verdict (parse failure) below the retry cap: increments attempts, leaves classified=0, no event", async () => {
    insertMemory(store, "mem-1");
    const { fn, events } = fakeAppendEvent();
    const worker = createClassifierWorker({
      db: store.db,
      classifier: {
        async classify() {
          return PARSE_FAILURE;
        },
      },
      appendEvent: fn,
    });
    expect(await worker.processOnce()).toBe("attempt_failed");
    const row = store.db
      .prepare("SELECT classified, classification_attempts FROM memories WHERE id = ?")
      .get("mem-1") as { classified: number; classification_attempts: number };
    expect(row.classified).toBe(0);
    expect(row.classification_attempts).toBe(1);
    expect(events).toHaveLength(0);
  });

  it("at attempt 3 (post-increment): gives up, writes conservative defaults, emits fallback_used=max_retries", async () => {
    insertMemory(store, "mem-1");
    store.db.prepare("UPDATE memories SET classification_attempts = 2 WHERE id = ?").run("mem-1");
    const { fn, events } = fakeAppendEvent();
    const worker = createClassifierWorker({
      db: store.db,
      classifier: {
        async classify() {
          return PARSE_FAILURE;
        },
      },
      appendEvent: fn,
    });
    expect(await worker.processOnce()).toBe("max_retries_giveup");
    const row = store.db
      .prepare(
        "SELECT classified, classification_attempts, is_global, requires_approval FROM memories WHERE id = ?",
      )
      .get("mem-1") as {
      classified: number;
      classification_attempts: number;
      is_global: number;
      requires_approval: number;
    };
    expect(row.classified).toBe(1);
    expect(row.classification_attempts).toBe(3);
    expect(row.is_global).toBe(0);
    expect(row.requires_approval).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      attempt_number: 3,
      fallback_used: "max_retries",
      parsed: null,
    });
  });

  it("three sequential attempts: two retries then giveup, single max_retries event", async () => {
    insertMemory(store, "mem-1");
    const { fn, events } = fakeAppendEvent();
    const worker = createClassifierWorker({
      db: store.db,
      classifier: {
        async classify() {
          return PARSE_FAILURE;
        },
      },
      appendEvent: fn,
    });
    expect(await worker.processOnce()).toBe("attempt_failed");
    expect(await worker.processOnce()).toBe("attempt_failed");
    expect(await worker.processOnce()).toBe("max_retries_giveup");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.fallback_used).toBe("max_retries");
    expect(events[0]?.payload.attempt_number).toBe(3);
    const row = store.db
      .prepare("SELECT classified, classification_attempts FROM memories WHERE id = ?")
      .get("mem-1") as { classified: number; classification_attempts: number };
    expect(row.classified).toBe(1);
    expect(row.classification_attempts).toBe(3);
  });

  it("if classifier throws (contract violation): counts as a failed attempt and may give up", async () => {
    insertMemory(store, "mem-1");
    store.db.prepare("UPDATE memories SET classification_attempts = 2 WHERE id = ?").run("mem-1");
    const { fn, events } = fakeAppendEvent();
    const worker = createClassifierWorker({
      db: store.db,
      classifier: {
        async classify() {
          throw new Error("boom");
        },
      },
      appendEvent: fn,
    });
    expect(await worker.processOnce()).toBe("max_retries_giveup");
    const row = store.db
      .prepare("SELECT classified, requires_approval FROM memories WHERE id = ?")
      .get("mem-1") as { classified: number; requires_approval: number };
    expect(row.classified).toBe(1);
    expect(row.requires_approval).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.fallback_used).toBe("max_retries");
  });

  it("on a fallback (provider_unavailable) below retry cap: stays classified=0 for the next iteration", async () => {
    insertMemory(store, "mem-1");
    const fail: ClassifyResult = {
      verdict: { requires_approval: true, is_global: false },
      fallback_used: "provider_unavailable",
      prompt_version: "v1",
      provider: "remote",
      model: "gpt-4o-mini",
      latency_ms: 3,
      raw_output: "",
    };
    const { fn } = fakeAppendEvent();
    const worker = createClassifierWorker({
      db: store.db,
      classifier: {
        async classify() {
          return fail;
        },
      },
      appendEvent: fn,
    });
    expect(await worker.processOnce()).toBe("attempt_failed");
    const row = store.db
      .prepare("SELECT classified, classification_attempts FROM memories WHERE id = ?")
      .get("mem-1") as { classified: number; classification_attempts: number };
    expect(row.classified).toBe(0);
    expect(row.classification_attempts).toBe(1);
  });
});

describe("classifier-worker.stop semantics", () => {
  it("waits for an in-flight iteration to finish before resolving", async () => {
    const { store, dataDir } = setupStore();
    try {
      insertMemory(store, "mem-1");
      let release: () => void = () => {};
      const inflight = new Promise<void>((resolve) => {
        release = resolve;
      });
      let writeObserved = false;
      const { events } = fakeAppendEvent();
      const worker = createClassifierWorker({
        db: store.db,
        classifier: {
          async classify() {
            await inflight;
            return SUCCESS;
          },
        },
        appendEvent: (eventType, payload, options) => {
          writeObserved = true;
          events.push({
            event_type: eventType,
            memory_id: options?.memory_id ?? null,
            agent_id: options?.agent_id ?? null,
            payload,
          });
        },
      });
      worker.start();
      // Yield so `tick()` enters the in-flight await.
      await new Promise((r) => setTimeout(r, 5));
      const stopped = worker.stop();
      let resolved = false;
      void stopped.then(() => {
        resolved = true;
      });
      // Still in flight — stop() must not have resolved yet.
      await new Promise((r) => setTimeout(r, 5));
      expect(resolved).toBe(false);
      expect(writeObserved).toBe(false);
      // Release the classify() and verify stop() resolves only after
      // the in-flight write reached appendEvent.
      release();
      await stopped;
      expect(resolved).toBe(true);
      expect(writeObserved).toBe(true);
    } finally {
      cleanupStore(store, dataDir);
    }
  });
});

describe("classifier-worker.start/stop polling loop", () => {
  it("processes queued rows back-to-back, then idles, then exits on stop", async () => {
    const { store, dataDir } = setupStore();
    try {
      insertMemory(store, "mem-1");
      insertMemory(store, "mem-2", { created_at: "2026-01-02T00:00:00Z" });
      const { fn, events } = fakeAppendEvent();
      const worker = createClassifierWorker({
        db: store.db,
        classifier: {
          async classify() {
            return SUCCESS;
          },
        },
        appendEvent: fn,
        // Deterministic scheduler: every setTimeoutFn handler runs on next microtask.
        setTimeoutFn: (handler) => {
          const t = setTimeout(handler, 0);
          return t;
        },
        clearTimeoutFn: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      });
      worker.start();
      // Yield the event loop enough times to drain both rows.
      await new Promise((r) => setTimeout(r, 30));
      await worker.stop();
      expect(events.length).toBe(2);
      expect(worker.running).toBe(false);
    } finally {
      cleanupStore(store, dataDir);
    }
  });
});

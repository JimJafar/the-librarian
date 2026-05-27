// Classifier worker — state-machine tests against an in-memory SQLite.
//
// The worker is wired but inert in production (Section 4a); these
// tests exercise it through `processOnce()` so we don't depend on the
// runtime polling loop.

import { DatabaseSync } from "node:sqlite";
import type { Classifier, ClassifyResult } from "@librarian/classifier";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClassifierWorker } from "../src/classifier-worker.ts";

interface EventLog {
  event_type: string;
  memory_id: string | null;
  agent_id: string | null;
  payload: Record<string, unknown>;
}

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      agent_id TEXT,
      created_at TEXT NOT NULL,
      is_global INTEGER NOT NULL DEFAULT 0,
      requires_approval INTEGER NOT NULL DEFAULT 0,
      classified INTEGER NOT NULL DEFAULT 0,
      classification_attempts INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

function insertMemory(
  db: DatabaseSync,
  id: string,
  overrides: { tags?: string[]; agent_id?: string | null; created_at?: string } = {},
): void {
  db.prepare(
    "INSERT INTO memories (id, title, body, tags_json, agent_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    `title-${id}`,
    `body-${id}`,
    JSON.stringify(overrides.tags ?? []),
    overrides.agent_id ?? "codex",
    overrides.created_at ?? "2026-01-01T00:00:00Z",
  );
}

function fakeClassifier(impl: () => Promise<ClassifyResult>): {
  classifier: Classifier;
  calls: number;
} {
  let calls = 0;
  return {
    classifier: {
      async classify() {
        calls += 1;
        return impl();
      },
    },
    get calls() {
      return calls;
    },
  };
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
  let db: DatabaseSync;

  beforeEach(() => {
    db = setupDb();
  });

  afterEach(() => {
    db.close();
  });

  it("returns idle when no memories are pending", async () => {
    const { fn } = fakeAppendEvent();
    const worker = createClassifierWorker({
      db,
      classifier: fakeClassifier(async () => SUCCESS).classifier,
      appendEvent: fn,
    });
    expect(await worker.processOnce()).toBe("idle");
  });

  it("classifies the oldest pending row first (created_at ORDER BY)", async () => {
    insertMemory(db, "mem-new", { created_at: "2026-02-01T00:00:00Z" });
    insertMemory(db, "mem-old", { created_at: "2026-01-01T00:00:00Z" });
    const seen: string[] = [];
    const classifier: Classifier = {
      async classify(input) {
        seen.push(input.title);
        return SUCCESS;
      },
    };
    const { fn } = fakeAppendEvent();
    const worker = createClassifierWorker({ db, classifier, appendEvent: fn });
    expect(await worker.processOnce()).toBe("processed");
    expect(seen).toEqual(["title-mem-old"]);
  });

  it("on success: writes the verdict, flips classified=1, emits memory.classified", async () => {
    insertMemory(db, "mem-1", { tags: ["identity"] });
    const { fn, events } = fakeAppendEvent();
    const worker = createClassifierWorker({
      db,
      classifier: {
        async classify() {
          return SUCCESS;
        },
      },
      appendEvent: fn,
    });
    expect(await worker.processOnce()).toBe("processed");
    const row = db
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

  it("on a fallback verdict (parse failure) below the retry cap: increments attempts, leaves classified=0, no event", async () => {
    insertMemory(db, "mem-1");
    const { fn, events } = fakeAppendEvent();
    const worker = createClassifierWorker({
      db,
      classifier: {
        async classify() {
          return PARSE_FAILURE;
        },
      },
      appendEvent: fn,
    });
    expect(await worker.processOnce()).toBe("attempt_failed");
    const row = db
      .prepare("SELECT classified, classification_attempts FROM memories WHERE id = ?")
      .get("mem-1") as { classified: number; classification_attempts: number };
    expect(row.classified).toBe(0);
    expect(row.classification_attempts).toBe(1);
    expect(events).toHaveLength(0);
  });

  it("at attempt 3 (post-increment): gives up, writes conservative defaults, emits fallback_used=max_retries", async () => {
    insertMemory(db, "mem-1");
    db.prepare("UPDATE memories SET classification_attempts = 2 WHERE id = ?").run("mem-1");
    const { fn, events } = fakeAppendEvent();
    const worker = createClassifierWorker({
      db,
      classifier: {
        async classify() {
          return PARSE_FAILURE;
        },
      },
      appendEvent: fn,
    });
    expect(await worker.processOnce()).toBe("max_retries_giveup");
    const row = db
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
    insertMemory(db, "mem-1");
    const { fn, events } = fakeAppendEvent();
    const worker = createClassifierWorker({
      db,
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
    const row = db
      .prepare("SELECT classified, classification_attempts FROM memories WHERE id = ?")
      .get("mem-1") as { classified: number; classification_attempts: number };
    expect(row.classified).toBe(1);
    expect(row.classification_attempts).toBe(3);
  });

  it("if classifier throws (contract violation): counts as a failed attempt and may give up", async () => {
    insertMemory(db, "mem-1");
    db.prepare("UPDATE memories SET classification_attempts = 2 WHERE id = ?").run("mem-1");
    const { fn, events } = fakeAppendEvent();
    const worker = createClassifierWorker({
      db,
      classifier: {
        async classify() {
          throw new Error("boom");
        },
      },
      appendEvent: fn,
    });
    expect(await worker.processOnce()).toBe("max_retries_giveup");
    const row = db
      .prepare("SELECT classified, requires_approval FROM memories WHERE id = ?")
      .get("mem-1") as { classified: number; requires_approval: number };
    expect(row.classified).toBe(1);
    expect(row.requires_approval).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.fallback_used).toBe("max_retries");
  });

  it("on a fallback (provider_unavailable) below retry cap: stays classified=0 for the next iteration", async () => {
    insertMemory(db, "mem-1");
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
      db,
      classifier: {
        async classify() {
          return fail;
        },
      },
      appendEvent: fn,
    });
    expect(await worker.processOnce()).toBe("attempt_failed");
    const row = db
      .prepare("SELECT classified, classification_attempts FROM memories WHERE id = ?")
      .get("mem-1") as { classified: number; classification_attempts: number };
    expect(row.classified).toBe(0);
    expect(row.classification_attempts).toBe(1);
  });
});

describe("classifier-worker.stop semantics", () => {
  it("waits for an in-flight iteration to finish before resolving", async () => {
    const db = setupDb();
    try {
      insertMemory(db, "mem-1");
      let release: () => void = () => {};
      const inflight = new Promise<void>((resolve) => {
        release = resolve;
      });
      let writeObserved = false;
      const { events } = fakeAppendEvent();
      const worker = createClassifierWorker({
        db,
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
      db.close();
    }
  });
});

describe("classifier-worker.start/stop polling loop", () => {
  it("processes queued rows back-to-back, then idles, then exits on stop", async () => {
    const db = setupDb();
    try {
      insertMemory(db, "mem-1");
      insertMemory(db, "mem-2");
      const { fn, events } = fakeAppendEvent();
      const worker = createClassifierWorker({
        db,
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
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 20));
      await worker.stop();
      expect(events.length).toBe(2);
      expect(worker.running).toBe(false);
    } finally {
      db.close();
    }
  });
});

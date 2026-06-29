import { checkIngestRateLimit } from "@librarian/core";
import { describe, expect, it } from "vitest";

// A minimal in-memory settings store (mirrors ingest-log.test.ts). The rate-limit
// counter is durable settings-sidecar state keyed by tokenId + UTC date.
function fakeSettings() {
  const map = new Map<string, string>();
  return {
    setSetting: (key: string, value: string) => map.set(key, value),
    getSetting: (key: string) => map.get(key) ?? null,
    deleteSetting: (key: string) => map.delete(key),
    listSettings: () => [...map.keys()].map((key) => ({ key })),
  };
}

describe("ingest rate limit — fail-soft (review finding #2)", () => {
  it("fails OPEN when the settings read throws (never blocks a legit capture)", () => {
    const throwingStore = {
      setSetting: () => {},
      getSetting: () => {
        throw new Error("settings store unavailable");
      },
      deleteSetting: () => {},
      listSettings: () => [],
    };
    // A getSetting throw must be caught and treated as a fresh bucket → allowed,
    // not propagate out and become a 500 on the /ingest hot path.
    expect(() => checkIngestRateLimit(throwingStore, "tok", {})).not.toThrow();
    expect(checkIngestRateLimit(throwingStore, "tok", {}).allowed).toBe(true);
  });
});

describe("ingest rate limit — burst cap (D19)", () => {
  it("allows a short run then 429s once the burst window fills", () => {
    const store = fakeSettings();
    const opts = { burstMax: 5, burstWindowMs: 10_000, dailyLimit: 200 };
    const now = Date.UTC(2026, 5, 28, 12, 0, 0);
    for (let i = 0; i < 5; i += 1) {
      expect(checkIngestRateLimit(store, "tok-1", { ...opts, now: now + i }).allowed).toBe(true);
    }
    const over = checkIngestRateLimit(store, "tok-1", { ...opts, now: now + 5 });
    expect(over.allowed).toBe(false);
    if (!over.allowed) expect(over.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("lets the burst recover once the window slides past", () => {
    const store = fakeSettings();
    const opts = { burstMax: 2, burstWindowMs: 1_000, dailyLimit: 200 };
    const now = Date.UTC(2026, 5, 28, 12, 0, 0);
    expect(checkIngestRateLimit(store, "t", { ...opts, now }).allowed).toBe(true);
    expect(checkIngestRateLimit(store, "t", { ...opts, now: now + 1 }).allowed).toBe(true);
    expect(checkIngestRateLimit(store, "t", { ...opts, now: now + 2 }).allowed).toBe(false);
    // 1.5 s later the window has slid past the first two — allowed again.
    expect(checkIngestRateLimit(store, "t", { ...opts, now: now + 1_500 }).allowed).toBe(true);
  });

  it("keys per token: one token's burst does not throttle another", () => {
    const store = fakeSettings();
    const opts = { burstMax: 1, burstWindowMs: 10_000, dailyLimit: 200 };
    const now = Date.UTC(2026, 5, 28, 12, 0, 0);
    expect(checkIngestRateLimit(store, "a", { ...opts, now }).allowed).toBe(true);
    expect(checkIngestRateLimit(store, "a", { ...opts, now: now + 1 }).allowed).toBe(false);
    // A different token is unaffected.
    expect(checkIngestRateLimit(store, "b", { ...opts, now: now + 1 }).allowed).toBe(true);
  });
});

describe("ingest rate limit — daily quota (D19)", () => {
  it("429s after the daily quota and resets on the next UTC day", () => {
    const store = fakeSettings();
    const opts = { burstMax: 1_000, burstWindowMs: 1, dailyLimit: 3 };
    const base = Date.UTC(2026, 5, 28, 8, 0, 0);
    // Space requests out so the burst window never trips — isolate the daily cap.
    for (let i = 0; i < 3; i += 1) {
      expect(checkIngestRateLimit(store, "d", { ...opts, now: base + i * 1000 }).allowed).toBe(
        true,
      );
    }
    const over = checkIngestRateLimit(store, "d", { ...opts, now: base + 3000 });
    expect(over.allowed).toBe(false);
    if (!over.allowed) expect(over.retryAfterSeconds).toBeGreaterThan(0);

    // Next UTC day: the daily counter resets.
    const nextDay = Date.UTC(2026, 5, 29, 0, 0, 1);
    expect(checkIngestRateLimit(store, "d", { ...opts, now: nextDay }).allowed).toBe(true);
  });
});

describe("ingest rate limit — stale-bucket GC (issue #423)", () => {
  it("deletes prior-day buckets (across tokens) on an accepted capture", () => {
    const store = fakeSettings();
    store.setSetting(
      "ingest_rate:tok-1:2026-06-01",
      JSON.stringify({ date: "2026-06-01", count: 5, recent: [] }),
    );
    store.setSetting(
      "ingest_rate:tok-2:2026-06-10",
      JSON.stringify({ date: "2026-06-10", count: 9, recent: [] }),
    );
    const now = Date.UTC(2026, 5, 29, 12, 0, 0); // 2026-06-29
    expect(checkIngestRateLimit(store, "tok-1", { now }).allowed).toBe(true);

    // Only today's bucket for the active token remains; the dead ones are swept.
    const rateKeys = store
      .listSettings()
      .map((s) => s.key)
      .filter((k) => k.startsWith("ingest_rate:"));
    expect(rateKeys).toEqual(["ingest_rate:tok-1:2026-06-29"]);
  });
});

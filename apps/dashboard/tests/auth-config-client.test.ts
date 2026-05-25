import { describe, expect, it, vi } from "vitest";
import { createAuthConfigCache } from "../lib/auth-config-client";

// A controllable clock + a fetch spy so we can assert TTL/bust/dedupe without timers.
function setup(initial = 0) {
  let nowMs = initial;
  const value = { enabled: false, methods: [] as string[] };
  const fetcher = vi.fn(async () => ({ ...value }));
  const cache = createAuthConfigCache({ fetcher, ttlMs: 30_000, now: () => nowMs });
  return { cache, fetcher, advance: (ms: number) => (nowMs += ms) };
}

describe("auth-config cache (D2.2)", () => {
  it("serves a cache hit within the TTL (one fetch)", async () => {
    const { cache, fetcher } = setup();
    await cache.get();
    await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refetches after the TTL elapses", async () => {
    const { cache, fetcher, advance } = setup();
    await cache.get();
    advance(30_001);
    await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("refetches after bust()", async () => {
    const { cache, fetcher } = setup();
    await cache.get();
    cache.bust();
    await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent reads into a single in-flight fetch", async () => {
    let resolve!: (v: { enabled: boolean }) => void;
    const fetcher = vi.fn(() => new Promise<{ enabled: boolean }>((r) => (resolve = r)));
    const cache = createAuthConfigCache({ fetcher, ttlMs: 30_000, now: () => 0 });

    const a = cache.get();
    const b = cache.get();
    resolve({ enabled: true });
    await Promise.all([a, b]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed fetch (next get retries)", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ enabled: true });
    const cache = createAuthConfigCache({ fetcher, ttlMs: 30_000, now: () => 0 });
    await expect(cache.get()).rejects.toThrow("boom");
    await expect(cache.get()).resolves.toEqual({ enabled: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

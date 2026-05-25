// D3.2: a minimal in-process sliding-window rate limiter. Defense in depth on the
// credentials login route, layered on top of the authoritative store-side lockout —
// it bounds raw request volume per client before a request even reaches the store.
// In-process is sufficient for a single-instance dashboard (same assumption as the
// auth-config cache); a multi-instance deploy would want a shared store.

export interface RateLimiter {
  /** Record an attempt for `key`; returns true if allowed, false if over the limit. */
  check(key: string): boolean;
}

// Bounds memory under a high-cardinality (e.g. spoofed-IP) flood: once the map
// exceeds this, fully-expired keys are swept. The store-side lockout is the
// authoritative gate, so this only protects the dashboard's own memory.
const MAX_KEYS = 10_000;

export function createRateLimiter(options: {
  limit: number;
  windowMs: number;
  now?: () => number;
}): RateLimiter {
  const now = options.now ?? Date.now;
  const hits = new Map<string, number[]>();
  return {
    check(key: string): boolean {
      const t = now();
      if (hits.size > MAX_KEYS) {
        for (const [k, ts] of hits) {
          if (ts.every((x) => t - x >= options.windowMs)) hits.delete(k);
        }
      }
      const recent = (hits.get(key) ?? []).filter((ts) => t - ts < options.windowMs);
      if (recent.length >= options.limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(t);
      hits.set(key, recent);
      return true;
    },
  };
}

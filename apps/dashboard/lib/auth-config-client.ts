import "server-only";
import { serverTRPC } from "./trpc-server";

// D2.2 — in-process cache around the `auth.config` tRPC procedure.
//
// Auth.js v5's lazy config and the middleware enforcement both read auth config on
// the hot path; hitting the MCP server per request would be wasteful and couple
// every page load to the store's latency. A single dashboard instance owns this
// cache, so a 30s TTL plus an explicit bust() on every mutation keeps it fresh
// without cross-instance invalidation. Concurrent reads share one in-flight fetch
// so a burst of requests doesn't fan out into parallel store calls.

const DEFAULT_TTL_MS = 30_000;
// Bound the hot-path config fetch so a half-open store (connection accepted, no
// response) surfaces as a fast throw → fail-closed "block" in middleware, rather
// than hanging every page request until the platform's default fetch timeout.
const FETCH_TIMEOUT_MS = 5_000;

export interface AuthConfigCache<T> {
  get(): Promise<T>;
  /** Drop the cached value so the next get() refetches (call after any mutation). */
  bust(): void;
}

export function createAuthConfigCache<T>(options: {
  fetcher: () => Promise<T>;
  ttlMs?: number;
  now?: () => number;
}): AuthConfigCache<T> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  let cached: { value: T; at: number } | null = null;
  let inflight: Promise<T> | null = null;

  function get(): Promise<T> {
    if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.value);
    if (inflight) return inflight; // dedupe concurrent reads
    inflight = options
      .fetcher()
      .then((value) => {
        cached = { value, at: now() };
        return value;
      })
      .finally(() => {
        inflight = null; // a failed fetch is not cached — the next get() retries
      });
    return inflight;
  }

  function bust(): void {
    cached = null;
  }

  return { get, bust };
}

export type DashboardAuthConfig = Awaited<ReturnType<typeof serverTRPC.auth.config.query>>;

const cache = createAuthConfigCache<DashboardAuthConfig>({
  fetcher: () =>
    serverTRPC.auth.config.query(undefined, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
});

/** Cached auth config for enforcement + lazy NextAuth assembly. */
export function getAuthConfig(): Promise<DashboardAuthConfig> {
  return cache.get();
}

/** Invalidate the cache — call from every auth mutation action so changes take effect at once. */
export function bustAuthConfig(): void {
  cache.bust();
}

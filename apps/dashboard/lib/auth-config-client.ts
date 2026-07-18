import "server-only";
import { bareServerTRPC } from "./trpc-server-bare";

// D2.2 — in-process cache around the `auth.config` tRPC procedure.
//
// Auth.js v5's lazy config and the middleware enforcement both read auth config on
// the hot path; hitting the MCP server per request would be wasteful and couple
// every page load to the store's latency. A single dashboard instance owns this
// cache, so a 30s TTL plus an explicit bust() on every mutation keeps it fresh
// without cross-instance invalidation. Concurrent reads share one in-flight fetch
// so a burst of requests doesn't fan out into parallel store calls. The
// temporary claim-pending state is deliberately not TTL-cached: it is the one
// transition that must become visible across dashboard/edge runtimes immediately
// after first-owner redemption.
//
// spec 065 SC 3: this fetch rides the BARE bootstrap client — MODULE-WIDE, so all four of its
// sessionless entry points (middleware's enforcement read, the NextAuth config factory, the login
// page, and the proxy's own enforcement gate) are covered at once. It must NOT ride the
// identity-bearing serverTRPC: that client's headers callback calls auth(), whose lazy config
// resolves through THIS very fetch — one client would await its own in-flight promise (a circular
// await re-arming on every cache expiry). The fetch is a machine call under process trust, so an
// absent assertion (today's isolation trust, ADR 0008 P3) is the honest classification.

// Default 30s; tunable via env (lower for tests, or for operators who want faster
// propagation of auth changes at the cost of more store reads).
const DEFAULT_TTL_MS = Number(process.env.LIBRARIAN_AUTH_CONFIG_TTL_MS) || 30_000;
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
  /** Volatile states may opt out of TTL caching while still sharing one fetch. */
  shouldCache?: (value: T) => boolean;
}): AuthConfigCache<T> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const shouldCache = options.shouldCache ?? (() => true);
  let cached: { value: T; at: number } | null = null;
  let inflight: Promise<T> | null = null;
  let generation = 0;

  function get(): Promise<T> {
    if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.value);
    if (inflight) return inflight; // dedupe concurrent reads
    const requestGeneration = generation;
    const request = options
      .fetcher()
      .then((value) => {
        // A mutation may bust while this request is still in flight. Never let
        // its stale result repopulate the cache after that invalidation.
        if (generation === requestGeneration && shouldCache(value)) {
          cached = { value, at: now() };
        }
        return value;
      })
      .finally(() => {
        // A post-bust fetch may already have replaced this request.
        if (inflight === request) inflight = null;
      });
    inflight = request;
    return request;
  }

  function bust(): void {
    generation += 1;
    cached = null;
    // Do not make the next caller await a request issued before the mutation.
    inflight = null;
  }

  return { get, bust };
}

export type DashboardAuthConfig = Awaited<ReturnType<typeof bareServerTRPC.auth.config.query>>;

const cache = createAuthConfigCache<DashboardAuthConfig>({
  fetcher: () =>
    bareServerTRPC.auth.config.query(undefined, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
  // claimPending flips exactly once during provisioning and must cross process/
  // edge runtime cache boundaries immediately. The temporary setup window can
  // afford one config read per request; the stable post-claim state is cached.
  shouldCache: (value) => !value.claimPending,
});

/** Cached auth config for enforcement + lazy NextAuth assembly. */
export function getAuthConfig(): Promise<DashboardAuthConfig> {
  return cache.get();
}

/** Like getAuthConfig but degrades to null on any failure (store unreachable) —
 *  for callers that fall back to the env path rather than throwing. */
export async function getAuthConfigSafe(): Promise<DashboardAuthConfig | null> {
  try {
    return await cache.get();
  } catch {
    return null;
  }
}

/** Invalidate the cache — call from every auth mutation action so changes take effect at once. */
export function bustAuthConfig(): void {
  cache.bust();
}

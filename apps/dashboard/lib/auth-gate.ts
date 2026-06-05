// Whether dashboard auth is ENFORCED, and how (A2; D2.4 made it store-driven).
//
// Enforcement now comes from the store auth-config (cached) so the owner can flip it
// from the dashboard without a redeploy, with the legacy LIBRARIAN_AUTH_ENABLED env
// as the fallback for A1–A5 deploys. The decision is fail-closed: an enabled-but-
// incomplete config, or an unreachable store, blocks rather than serving open.
//
// This module stays pure (no store/server-only import) so the decision table is
// unit-tested directly; callers inject the config fetcher.

export type Enforcement = "open" | "enforce" | "block";

/** Legacy env signal — the fallback when the store carries no auth config. */
export function isAuthEnforced(
  env: { LIBRARIAN_AUTH_ENABLED?: string } = process.env as { LIBRARIAN_AUTH_ENABLED?: string },
): boolean {
  // Strictly "true" — any other value fails safe to "not enforced".
  return env.LIBRARIAN_AUTH_ENABLED === "true";
}

/** The enforcement-relevant projection of the resolved config. */
export interface EnforcementConfig {
  enabled: boolean;
  complete: boolean;
}

/** The slice of the dashboard auth-config the enforcement decision reads. */
export interface AuthConfigShape {
  enabled: boolean;
  methods: string[];
  authSecret: string | null;
  oauth?: { github?: unknown; google?: unknown };
  ownerOAuth?: { github?: string; google?: string };
}

// Mirror of core's isAuthConfigComplete. Deliberately re-implemented here rather
// than imported: pulling @librarian/core (node:crypto) into the middleware bundle
// would break on non-Node runtimes. Kept in lockstep with the core check — the
// cross-implementation equivalence test (auth-gate-equivalence.test.ts) fails CI
// if the two ever diverge. Exported solely so that test can reach it.
export function configComplete(cfg: AuthConfigShape): boolean {
  if (!cfg.authSecret) return false;
  if (cfg.methods.includes("password")) return true;
  if (cfg.oauth?.github && cfg.ownerOAuth?.github) return true;
  if (cfg.oauth?.google && cfg.ownerOAuth?.google) return true;
  return false;
}

/**
 * Project a fetched config to the enforcement shape, or null when the store carries
 * no auth config (unconfigured/legacy) — the caller then falls back to env. A config
 * counts as "store-managed" once the flag is set or any method is configured.
 */
export function toEnforcementConfig(cfg: AuthConfigShape | null): EnforcementConfig | null {
  if (!cfg) return null;
  const storeManaged = cfg.enabled || cfg.methods.length > 0;
  if (!storeManaged) return null;
  return { enabled: cfg.enabled, complete: configComplete(cfg) };
}

/**
 * The fail-closed enforcement decision. The legacy env flag is a FLOOR: a
 * store-managed config can escalate enforcement but never silently drop below an
 * env-enforced deploy (so an A1–A5 box that starts configuring auth in the
 * dashboard, but hasn't called enable yet, keeps enforcing).
 * - unreachable store    → block (can't verify the posture, so don't serve)
 * - no store config      → the env flag decides
 * - disabled             → enforce if env says so, else open
 * - enabled + complete   → enforce (require a session)
 * - enabled + incomplete → block (never serve with a half-configured gate)
 */
export function decideEnforcement(
  config: EnforcementConfig | null | "unreachable",
  envEnabled: boolean,
): Enforcement {
  if (config === "unreachable") return "block";
  if (config === null) return envEnabled ? "enforce" : "open";
  if (!config.enabled) return envEnabled ? "enforce" : "open";
  return config.complete ? "enforce" : "block";
}

/**
 * Resolve enforcement by reading the (injected) config fetcher, fail-closing to
 * "block" if it throws (store unreachable). Callers pass `() => getAuthConfig()`.
 */
export async function resolveEnforcement(
  fetchConfig: () => Promise<AuthConfigShape | null>,
  env: { LIBRARIAN_AUTH_ENABLED?: string } = process.env as { LIBRARIAN_AUTH_ENABLED?: string },
): Promise<Enforcement> {
  let config: EnforcementConfig | null | "unreachable";
  try {
    config = toEnforcementConfig(await fetchConfig());
  } catch {
    config = "unreachable";
  }
  return decideEnforcement(config, isAuthEnforced(env));
}

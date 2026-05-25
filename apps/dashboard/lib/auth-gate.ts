// A2: the single source of truth for whether dashboard auth is ENFORCED.
//
// Login is wired in A1 regardless; this flag gates enforcement (middleware
// redirects + the tRPC proxy session check) so the rollout can land login
// first and flip enforcement on without a lock-out window. Strictly "true"
// — any other value (unset, "false", "1", "TRUE") is off, so a typo fails
// safe to "not enforced" rather than silently half-enforcing.

export function isAuthEnforced(
  env: { LIBRARIAN_AUTH_ENABLED?: string } = process.env as { LIBRARIAN_AUTH_ENABLED?: string },
): boolean {
  return env.LIBRARIAN_AUTH_ENABLED === "true";
}

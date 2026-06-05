import { type AuthConfig, isAuthConfigComplete } from "@librarian/core";
import { describe, expect, it } from "vitest";
import { type AuthConfigShape, configComplete } from "@/lib/auth-gate";

// The dashboard middleware re-implements core's auth-completeness check
// (configComplete) instead of importing it, to keep node:crypto out of the
// middleware bundle. The two are kept in lockstep by a comment only — if they
// drift, the auth gate silently weakens (e.g. an OAuth-only config the owner
// can't actually log in with starts counting as "complete"). This table-driven
// test pins them together: for every representative config it asserts that the
// dashboard mirror and the core check return the SAME boolean. A divergence is a
// real auth-gate bug and must fail CI.
//
// Fixtures use obviously-fake short placeholders for any secret-shaped field.

// A neutral description of one auth posture, from which we derive the matching
// input for each implementation. Driving both shapes from a single row keeps the
// mapping honest — neither side gets a hand-tuned, divergent input.
interface Posture {
  name: string;
  /** A derivable JWT secret exists (core: authSecret non-null/non-empty). */
  hasSecret: boolean;
  /** Password method is fully configured. */
  password: boolean;
  /** GitHub OAuth client creds are present. */
  githubCreds: boolean;
  /** GitHub OAuth owner is allowlisted. */
  githubOwner: boolean;
  /** Google OAuth client creds are present. */
  googleCreds: boolean;
  /** Google OAuth owner is allowlisted. */
  googleOwner: boolean;
  /** What both impls are expected to return — documents the intended gate. */
  expected: boolean;
}

const FAKE_SECRET = "x"; // obviously-fake JWT secret placeholder
const FAKE_CLIENT = { clientId: "x", clientSecret: "fake-secret" };
const FAKE_OWNER = "owner-1";

const postures: Posture[] = [
  // No secret available — incomplete regardless of methods.
  {
    name: "no derivable secret, nothing configured",
    hasSecret: false,
    password: false,
    githubCreds: false,
    githubOwner: false,
    googleCreds: false,
    googleOwner: false,
    expected: false,
  },
  {
    name: "no derivable secret but password otherwise complete",
    hasSecret: false,
    password: true,
    githubCreds: false,
    githubOwner: false,
    googleCreds: false,
    googleOwner: false,
    expected: false,
  },
  {
    name: "no derivable secret but full github oauth",
    hasSecret: false,
    password: false,
    githubCreds: true,
    githubOwner: true,
    googleCreds: false,
    googleOwner: false,
    expected: false,
  },
  // Secret present, no usable method.
  {
    name: "secret but no methods at all",
    hasSecret: true,
    password: false,
    githubCreds: false,
    githubOwner: false,
    googleCreds: false,
    googleOwner: false,
    expected: false,
  },
  // Password method.
  {
    name: "password only",
    hasSecret: true,
    password: true,
    githubCreds: false,
    githubOwner: false,
    googleCreds: false,
    googleOwner: false,
    expected: true,
  },
  // GitHub OAuth — half configured (creds without owner = deny-everyone).
  {
    name: "github creds without owner (would lock owner out)",
    hasSecret: true,
    password: false,
    githubCreds: true,
    githubOwner: false,
    googleCreds: false,
    googleOwner: false,
    expected: false,
  },
  {
    name: "github owner allowlisted but no creds",
    hasSecret: true,
    password: false,
    githubCreds: false,
    githubOwner: true,
    googleCreds: false,
    googleOwner: false,
    expected: false,
  },
  {
    name: "github creds + owner (complete)",
    hasSecret: true,
    password: false,
    githubCreds: true,
    githubOwner: true,
    googleCreds: false,
    googleOwner: false,
    expected: true,
  },
  // Google OAuth — symmetric to github.
  {
    name: "google creds without owner",
    hasSecret: true,
    password: false,
    githubCreds: false,
    githubOwner: false,
    googleCreds: true,
    googleOwner: false,
    expected: false,
  },
  {
    name: "google owner without creds",
    hasSecret: true,
    password: false,
    githubCreds: false,
    githubOwner: false,
    googleCreds: false,
    googleOwner: true,
    expected: false,
  },
  {
    name: "google creds + owner (complete)",
    hasSecret: true,
    password: false,
    githubCreds: false,
    githubOwner: false,
    googleCreds: true,
    googleOwner: true,
    expected: true,
  },
  // Cross-provider half-configs: creds for one provider, owner for the other.
  {
    name: "github creds + google owner (neither provider usable)",
    hasSecret: true,
    password: false,
    githubCreds: true,
    githubOwner: false,
    googleCreds: false,
    googleOwner: true,
    expected: false,
  },
  // Multiple methods together.
  {
    name: "password + full github oauth",
    hasSecret: true,
    password: true,
    githubCreds: true,
    githubOwner: true,
    googleCreds: false,
    googleOwner: false,
    expected: true,
  },
  {
    name: "both providers fully configured",
    hasSecret: true,
    password: false,
    githubCreds: true,
    githubOwner: true,
    googleCreds: true,
    googleOwner: true,
    expected: true,
  },
  {
    name: "everything configured (password + both providers)",
    hasSecret: true,
    password: true,
    githubCreds: true,
    githubOwner: true,
    googleCreds: true,
    googleOwner: true,
    expected: true,
  },
  // Password present but secret missing AND oauth fully configured — secret gate
  // must still dominate.
  {
    name: "no secret, password + both providers complete",
    hasSecret: false,
    password: true,
    githubCreds: true,
    githubOwner: true,
    googleCreds: true,
    googleOwner: true,
    expected: false,
  },
];

/** The core AuthConfig shape for a posture. `methods` mirrors getAuthConfig:
 *  password is listed when the password method is configured, and each OAuth
 *  provider is listed when its creds are present (owner does not affect methods). */
function toCoreConfig(p: Posture): AuthConfig {
  const methods: AuthConfig["methods"] = [];
  if (p.password) methods.push("password");
  if (p.githubCreds) methods.push("github");
  if (p.googleCreds) methods.push("google");
  return {
    enabled: true,
    methods,
    password: p.password ? { username: "owner" } : null,
    oauth: {
      ...(p.githubCreds ? { github: FAKE_CLIENT } : {}),
      ...(p.googleCreds ? { google: FAKE_CLIENT } : {}),
    },
    ownerOAuth: {
      ...(p.githubOwner ? { github: FAKE_OWNER } : {}),
      ...(p.googleOwner ? { google: FAKE_OWNER } : {}),
    },
    authSecret: p.hasSecret ? FAKE_SECRET : null,
  };
}

/** The dashboard AuthConfigShape for the same posture, built independently so the
 *  two impls receive structurally analogous (not shared) inputs. */
function toDashboardShape(p: Posture): AuthConfigShape {
  const methods: string[] = [];
  if (p.password) methods.push("password");
  if (p.githubCreds) methods.push("github");
  if (p.googleCreds) methods.push("google");
  return {
    enabled: true,
    methods,
    authSecret: p.hasSecret ? FAKE_SECRET : null,
    oauth: {
      ...(p.githubCreds ? { github: FAKE_CLIENT } : {}),
      ...(p.googleCreds ? { google: FAKE_CLIENT } : {}),
    },
    ownerOAuth: {
      ...(p.githubOwner ? { github: FAKE_OWNER } : {}),
      ...(p.googleOwner ? { google: FAKE_OWNER } : {}),
    },
  };
}

describe("auth-gate completeness: dashboard mirror matches core", () => {
  it.each(postures)("configComplete and isAuthConfigComplete agree for: $name", (posture) => {
    const core = isAuthConfigComplete(toCoreConfig(posture));
    const dashboard = configComplete(toDashboardShape(posture));

    // The guard: the two implementations must never disagree.
    expect(dashboard).toBe(core);
    // And both must match the intended gate documented in the table, so a
    // matching-but-wrong pair can't pass silently.
    expect(core).toBe(posture.expected);
  });
});

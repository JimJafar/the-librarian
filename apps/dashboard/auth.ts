// Dashboard owner login (Auth.js v5) — D2.3 made the config dynamic.
//
// v5 lazy initialization: NextAuth takes an (async) config function evaluated per
// request, so providers + secret + the owner allowlist are assembled from the
// store auth-config (cached, 30s TTL) instead of being frozen from env at module
// load. When the store has no auth config (a fresh or legacy A1–A5 deploy), it
// falls back to the env-configured providers + LIBRARIAN_OWNER_* allowlist, so
// existing deployments are untouched. JWT sessions keep the "dashboard never opens
// the store" invariant; AUTH_SECRET is the HKDF-derived value from the config.
//
// The Credentials (password) provider and the login form land in D3.

import NextAuth, { type NextAuthConfig } from "next-auth";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import { type DashboardAuthConfig, getAuthConfig } from "@/lib/auth-config-client";
import { isAllowedOwner, resolveOwnerAllowlist } from "@/lib/owner-allowlist";

// Best-effort read of the store config; on any failure (store unreachable) return
// null so we degrade to the env fallback rather than throwing during config assembly.
async function loadAuthConfig(): Promise<DashboardAuthConfig | null> {
  try {
    return await getAuthConfig();
  } catch {
    return null;
  }
}

type Providers = NextAuthConfig["providers"];

function buildProviders(config: DashboardAuthConfig | null, storeConfigured: boolean): Providers {
  const providers: Providers = [];
  if (storeConfigured) {
    const oauth = config?.oauth ?? {};
    if (oauth.github) {
      providers.push(
        GitHub({ clientId: oauth.github.clientId, clientSecret: oauth.github.clientSecret }),
      );
    }
    if (oauth.google) {
      providers.push(
        Google({ clientId: oauth.google.clientId, clientSecret: oauth.google.clientSecret }),
      );
    }
    return providers;
  }
  // Legacy env fallback (A1): providers infer creds from AUTH_GITHUB_*/AUTH_GOOGLE_*.
  if (process.env.AUTH_GITHUB_ID) providers.push(GitHub);
  if (process.env.AUTH_GOOGLE_ID) providers.push(Google);
  return providers;
}

export const { handlers, auth, signIn, signOut } = NextAuth(async (): Promise<NextAuthConfig> => {
  const config = await loadAuthConfig();
  const storeConfigured = !!config && config.methods.length > 0;
  const allowlist = resolveOwnerAllowlist(config);
  // Derived from LIBRARIAN_SECRET_KEY (config), falling back to the legacy env.
  const secret = config?.authSecret ?? process.env.AUTH_SECRET;

  return {
    providers: buildProviders(config, storeConfigured),
    session: { strategy: "jwt" },
    // The dashboard runs behind a proxy (Fly/Docker), not on Vercel, so the host
    // can't be auto-trusted — opt in explicitly.
    trustHost: true,
    // Omit entirely when unset (exactOptionalPropertyTypes) — NextAuth then errors
    // loudly at use rather than being handed an explicit undefined.
    ...(secret ? { secret } : {}),
    pages: { signIn: "/login" },
    callbacks: {
      // Single-owner gate: only the allowlisted account may complete sign-in.
      // Deny-by-default lives in isAllowedOwner; the try/catch makes the boundary
      // itself fail-closed so any unexpected throw denies rather than letting the
      // user retry past it.
      signIn({ account, profile }) {
        try {
          return isAllowedOwner(
            {
              provider: account?.provider ?? null,
              accountId: account?.providerAccountId ?? null,
              email: profile?.email ?? null,
              // GitHub profiles carry no email_verified, so it reads as unverified
              // here — GitHub owners must allowlist by account id, not email.
              emailVerified: profile?.email_verified === true,
            },
            allowlist,
          );
        } catch {
          return false;
        }
      },
    },
  };
});

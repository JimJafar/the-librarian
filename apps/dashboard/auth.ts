// A1: dashboard owner login (Auth.js v5 / next-auth@5 beta) on Next 15 app-router.
//
// Wired but NOT enforced in this slice — there is no middleware yet (A2), so
// creating this file changes nothing for existing deploys until LIBRARIAN_AUTH_ENABLED
// flips on. JWT sessions keep the dashboard's "never opens the store" invariant:
// the only persistent state is the owner allowlist, which lives in env.
//
// Provider credentials are inferred from env by Auth.js v5: AUTH_GITHUB_ID/SECRET,
// AUTH_GOOGLE_ID/SECRET, plus AUTH_SECRET for JWT signing. The owner allowlist
// (LIBRARIAN_OWNER_*) is enforced in the signIn callback via isAllowedOwner.

import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import { isAllowedOwner } from "@/lib/owner-allowlist";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [GitHub, Google],
  session: { strategy: "jwt" },
  // The dashboard runs behind a proxy (Fly/Docker), not on Vercel, so the host
  // can't be auto-trusted — opt in explicitly.
  trustHost: true,
  pages: { signIn: "/login" },
  callbacks: {
    // Single-owner gate: only the allowlisted account may complete sign-in.
    // Deny-by-default lives in isAllowedOwner (no owner configured → no login);
    // the try/catch makes the boundary itself fail-closed so any unexpected
    // throw denies rather than surfacing as an error the user could retry past.
    signIn({ account, profile }) {
      try {
        return isAllowedOwner({
          provider: account?.provider ?? null,
          accountId: account?.providerAccountId ?? null,
          email: profile?.email ?? null,
          // GitHub profiles carry no email_verified, so it reads as unverified
          // here — GitHub owners must allowlist by account id, not email.
          emailVerified: profile?.email_verified === true,
        });
      } catch {
        return false;
      }
    },
  },
});

// spec 065 SC 2 — a STABLE SUBJECT on the dashboard session.
//
// The default Auth.js v5 session exposes `user.{name,email,image}` only. The identity assertion
// (SC 1/SC 3) needs a stable `{provider, sub}` pair — `sub` alone is NOT unique across providers
// (GitHub and Google both mint numeric ids) — so these callbacks persist `token.sub` and
// `account.provider` at sign-in and expose both on the session. Extracted from auth.ts so they are
// unit-testable without NextAuth (the credentials-authorize.ts pattern).

import type { Account, Session } from "next-auth";
import type { JWT } from "next-auth/jwt";

/**
 * The credentials owner's PINNED subject (spec 065 Q1, resolved at T2). `authorizeOwnerCredentials`
 * returns `{ id: username, name: username }` — the TYPED username — so Auth.js would default
 * `token.sub` to it. But the username is MUTABLE (`auth.redeemSetupLink` accepts a new one, and the
 * password config owns it), and a subject that changes when the owner renames themselves is not
 * stable — a member-aware provider's mapping would silently detach. The password path is
 * single-OWNER by design (one credential, one identity), so the subject is this constant, pinned
 * in the `jwt` callback regardless of the typed username. Documented on the extension docs page.
 */
export const CREDENTIALS_OWNER_SUB = "owner";

/** The provider name Auth.js reports for the Credentials (password) provider. */
export const CREDENTIALS_PROVIDER = "credentials";

/**
 * `jwt` callback body: persist the stable subject at sign-in. `account` is only present on the
 * sign-in invocation — later refreshes keep whatever the token already carries. OAuth accounts
 * keep Auth.js's own `token.sub` (the provider account id); the credentials owner gets the pinned
 * constant (see {@link CREDENTIALS_OWNER_SUB}).
 */
export function persistIdentityToToken(token: JWT, account?: Account | null): JWT {
  if (account) {
    token.provider = account.provider;
    if (account.provider === CREDENTIALS_PROVIDER) token.sub = CREDENTIALS_OWNER_SUB;
  }
  return token;
}

/**
 * `session` callback body: expose the persisted `{sub, provider}` on `session.user` (typed by
 * types/next-auth.d.ts), where the proxy and the identity callback read them.
 */
export function exposeIdentityOnSession(session: Session, token: JWT): Session {
  if (session.user) {
    if (typeof token.sub === "string" && token.sub) session.user.sub = token.sub;
    if (typeof token.provider === "string" && token.provider) {
      session.user.provider = token.provider;
    }
  }
  return session;
}

// Session/JWT augmentation for the dashboard identity assertion (spec 065 SC 2).
//
// The default Auth.js v5 session exposes `user.{name,email,image}` only — no stable subject and
// no originating provider. The dashboard's proxy + identity callback (spec 065 SC 1 / SC 3) derive
// the assertion from a STABLE subject, so the session must carry `sub` + `provider`. These are
// populated by the `jwt`/`session` callbacks in `auth.ts` (SC 2); this file only declares their
// types so the setter can read them without a cast.

import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      /** The stable subject: `token.sub` (OAuth account id, or the pinned credentials constant). */
      sub?: string;
      /** The originating provider ("github" | "google" | "credentials") — `sub` is not unique across providers. */
      provider?: string;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    /** The originating provider, persisted at sign-in from `account.provider` (SC 2). */
    provider?: string;
  }
}

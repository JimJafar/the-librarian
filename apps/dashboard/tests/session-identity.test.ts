import type { Account, Session } from "next-auth";
import type { JWT } from "next-auth/jwt";
import { describe, expect, it } from "vitest";
import {
  CREDENTIALS_OWNER_SUB,
  CREDENTIALS_PROVIDER,
  exposeIdentityOnSession,
  persistIdentityToToken,
} from "@/lib/session-identity";

// spec 065 SC 2 — the STABLE SUBJECT: `jwt`/`session` callbacks persist `sub` + `provider` at
// sign-in and expose both on the session. The credentials owner's sub is the PINNED constant
// (Q1 resolution): `authorizeOwnerCredentials` returns the TYPED username as `id`, but the
// username is mutable (redeemSetupLink can change it), so the single-owner password identity
// gets a constant subject instead.

function account(provider: string): Account {
  return { provider, providerAccountId: "acct-1", type: "oauth" } as Account;
}

function session(user: Session["user"]): Session {
  return { user, expires: "2027-01-01T00:00:00.000Z" } as Session;
}

describe("persistIdentityToToken (jwt callback, SC 2)", () => {
  it("an OAuth sign-in persists the provider and keeps Auth.js's own sub (the provider account id)", () => {
    const token: JWT = { sub: "12345" };
    const out = persistIdentityToToken(token, account("github"));
    expect(out.sub).toBe("12345");
    expect(out.provider).toBe("github");
  });

  it("a credentials sign-in pins the CONSTANT subject, regardless of the typed username", () => {
    // authorizeOwnerCredentials returns { id: username }, so Auth.js seeds sub with the TYPED
    // username — which is mutable config, not a stable subject. The callback overrides it.
    const token: JWT = { sub: "jim-the-typed-username" };
    const out = persistIdentityToToken(token, account(CREDENTIALS_PROVIDER));
    expect(out.sub).toBe(CREDENTIALS_OWNER_SUB);
    expect(out.provider).toBe(CREDENTIALS_PROVIDER);
  });

  it("the pinned credentials subject is the documented constant", () => {
    expect(CREDENTIALS_OWNER_SUB).toBe("owner");
  });

  it("a refresh call (no account) leaves the persisted identity untouched", () => {
    const token: JWT = { sub: "12345", provider: "google" };
    const out = persistIdentityToToken(token, null);
    expect(out.sub).toBe("12345");
    expect(out.provider).toBe("google");
  });
});

describe("exposeIdentityOnSession (session callback, SC 2)", () => {
  it("an OAuth-shaped token exposes {provider, sub} on session.user", () => {
    const out = exposeIdentityOnSession(session({ name: "Owner", email: "o@e.co" }), {
      sub: "12345",
      provider: "github",
    });
    expect(out.user?.sub).toBe("12345");
    expect(out.user?.provider).toBe("github");
    // The default fields survive.
    expect(out.user?.name).toBe("Owner");
    expect(out.user?.email).toBe("o@e.co");
  });

  it("a credentials-shaped token exposes the pinned constant", () => {
    const out = exposeIdentityOnSession(session({ name: "owner" }), {
      sub: CREDENTIALS_OWNER_SUB,
      provider: CREDENTIALS_PROVIDER,
    });
    expect(out.user?.sub).toBe(CREDENTIALS_OWNER_SUB);
    expect(out.user?.provider).toBe(CREDENTIALS_PROVIDER);
  });

  it("a token without the identity fields leaves the session without them (no fabrication)", () => {
    const out = exposeIdentityOnSession(session({ name: "Owner" }), {});
    expect(out.user?.sub).toBeUndefined();
    expect(out.user?.provider).toBeUndefined();
  });
});

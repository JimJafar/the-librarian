// Spec 061 T1 — the Principal shape the DEFAULT auth provider produces.
//
// SC 2 pins that `defaultAuthProvider` reproduces today's per-surface matrix over the
// `Principal` currency; the sibling suites (per-surface-role, allow-no-auth, capture-scope,
// db-tokens) already prove the delegating `authenticateMcp`/`authenticatePublic` stay
// byte-identical. THIS suite pins the NEW shape AuthResult cannot carry: the
// actorId/boundActorId split (spec 061 SC 1). Above all it asserts the load-bearing SC 1/SC 3
// invariant — the env single-token and localhost-bypass paths yield a documented SENTINEL
// `actorId` and NO `boundActorId`, so a sentinel can never masquerade as a credential binding
// (which would trip resolveCaller's impersonation guard for every self-identifying agent).
//
// Unit-tests the compiled auth seam directly, like the sibling suites.

import type { IncomingMessage } from "node:http";
import { SENTINEL_ACTOR_IDS, SYSTEM_ACTOR_IDS } from "@librarian/core";
import { describe, expect, it } from "vitest";
import { type AuthConfig, defaultAuthProvider } from "../../dist/http/auth.js";

function reqWith(token?: string): IncomingMessage {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as unknown as IncomingMessage;
}

// A config exercising every credential branch: a per-agent MAP token (binds "claude"), a
// shared ENV single token (binds nobody), and DB-minted tokens of each scope (bind via their
// `<id>`). allowNoAuth false so the localhost bypass is off unless a test flips it on.
const baseConfig: AuthConfig = {
  adminToken: "",
  agentToken: "env-agent",
  agentTokenMap: new Map([["claude", "map-tok"]]),
  allowedOrigins: [],
  allowNoAuth: false,
  host: "0.0.0.0",
  port: 3838,
  verifyDbToken: (t) => {
    if (t === "db-agent") return { agentId: "clipper", scope: "agent", tokenId: "lib.abc" };
    if (t === "db-cap") return { agentId: "grabber", scope: "capture", tokenId: "lib.def" };
    return null;
  },
};

const provider = defaultAuthProvider(baseConfig);

describe("defaultAuthProvider — sentinel actors NEVER bind (spec 061 SC 1/SC 3)", () => {
  it("env single-token path → sentinel actorId `env-token-agent` and NO boundActorId", () => {
    const result = provider.authenticate(reqWith("env-agent"), "public");
    expect(result).toEqual({
      ok: true,
      principal: { kind: "agent", actorId: "env-token-agent", roles: ["agent"], scope: "agent" },
    });
    // The SC 1 invariant, pinned explicitly: authenticated, but bound to nobody.
    if (!result.ok) throw new Error("unreachable");
    expect(result.principal.actorId).toBe(SENTINEL_ACTOR_IDS.envToken);
    expect(result.principal).not.toHaveProperty("boundActorId");
  });

  it("localhost no-auth bypass → sentinel actorId `local-agent` and NO boundActorId", () => {
    const bypass = defaultAuthProvider({ ...baseConfig, allowNoAuth: true });
    // No bearer at all under the bypass → the local-agent sentinel, distinct from env-token.
    const result = bypass.authenticate(reqWith(), "public");
    expect(result).toEqual({
      ok: true,
      principal: { kind: "agent", actorId: "local-agent", roles: ["agent"], scope: "agent" },
    });
    if (!result.ok) throw new Error("unreachable");
    expect(result.principal.actorId).toBe(SENTINEL_ACTOR_IDS.localhost);
    expect(result.principal).not.toHaveProperty("boundActorId");
    // A bogus bearer under the bypass is still the local-agent sentinel (never admin, never bound).
    expect(bypass.authenticate(reqWith("bogus"), "public")).toEqual({
      ok: true,
      principal: { kind: "agent", actorId: "local-agent", roles: ["agent"], scope: "agent" },
    });
  });

  it("a single-port proxy request never inherits the localhost no-auth bypass", () => {
    const bypass = defaultAuthProvider({ ...baseConfig, allowNoAuth: true });
    const proxied = {
      headers: { "x-librarian-require-auth": "single-port" },
    } as unknown as IncomingMessage;
    const proxiedWithToken = {
      headers: {
        authorization: "Bearer env-agent",
        "x-librarian-require-auth": "single-port",
      },
    } as unknown as IncomingMessage;

    expect(bypass.authenticate(proxied, "public", "agent")).toEqual({
      ok: false,
      status: 401,
      reason: "missing",
    });
    expect(bypass.authenticate(proxiedWithToken, "public", "agent")).toMatchObject({ ok: true });
  });

  it("a DB verifier match with NO agentId → the env-token sentinel bucket, no boundActorId, tokenId preserved (spec 061 review fix 8)", () => {
    // A hand-edited / malformed record can make verifyDbToken return a match with no agentId. It is
    // authenticated but binds nobody, so it lands in the env-token sentinel bucket (NOT produced by
    // a well-formed record). Pins the bucket without changing the verifier.
    const noAgentIdCfg = defaultAuthProvider({
      ...baseConfig,
      verifyDbToken: (t) => (t === "db-noagent" ? { scope: "agent", tokenId: "lib.xyz" } : null),
    });
    const result = noAgentIdCfg.authenticate(reqWith("db-noagent"), "public");
    expect(result).toEqual({
      ok: true,
      principal: {
        kind: "agent",
        actorId: SENTINEL_ACTOR_IDS.envToken,
        roles: ["agent"],
        scope: "agent",
        tokenId: "lib.xyz",
      },
    });
    if (!result.ok) throw new Error("unreachable");
    expect(result.principal).not.toHaveProperty("boundActorId");
  });
});

describe("defaultAuthProvider — credential-bound principals set boundActorId = actorId", () => {
  it("per-agent MAP token → boundActorId AND actorId are both the bound id", () => {
    const result = provider.authenticate(reqWith("map-tok"), "public");
    expect(result).toEqual({
      ok: true,
      principal: {
        kind: "agent",
        actorId: "claude",
        boundActorId: "claude",
        roles: ["agent"],
        scope: "agent",
      },
    });
    if (!result.ok) throw new Error("unreachable");
    expect(result.principal.boundActorId).toBe(result.principal.actorId);
  });

  it("DB-minted `lib.<id>` token → bound id in BOTH ids, carrying its scope + tokenId", () => {
    expect(provider.authenticate(reqWith("db-agent"), "public")).toEqual({
      ok: true,
      principal: {
        kind: "agent",
        actorId: "clipper",
        boundActorId: "clipper",
        roles: ["agent"],
        scope: "agent",
        tokenId: "lib.abc",
      },
    });
  });
});

describe("defaultAuthProvider — internal surface is the trusted admin principal (ADR 0008 P3)", () => {
  it("internal → admin actor, admin role, bound to nothing (the socket is the boundary)", () => {
    const result = provider.authenticate(reqWith(), "internal");
    expect(result).toEqual({
      ok: true,
      principal: { kind: "admin", actorId: "dashboard-admin", roles: ["admin"] },
    });
    if (!result.ok) throw new Error("unreachable");
    expect(result.principal.actorId).toBe(SYSTEM_ACTOR_IDS.dashboardAdmin);
    expect(result.principal.roles).toContain("admin");
    expect(result.principal).not.toHaveProperty("boundActorId");
  });
});

describe("defaultAuthProvider — the 401/403 discrimination the wire contract needs (SC 2)", () => {
  it("missing / invalid credential → { ok: false, status: 401 }", () => {
    expect(provider.authenticate(reqWith(), "public", "agent")).toEqual({
      ok: false,
      status: 401,
      reason: "missing",
    });
    expect(provider.authenticate(reqWith("nope"), "public", "agent")).toEqual({
      ok: false,
      status: 401,
      reason: "invalid",
    });
  });

  it("valid credential, WRONG scope → { ok: false, status: 403 } (right key, wrong door)", () => {
    // A capture-scope DB token can't reach the agent surface…
    expect(provider.authenticate(reqWith("db-cap"), "public", "agent")).toEqual({
      ok: false,
      status: 403,
      reason: "wrong-scope",
      principal: {
        kind: "agent",
        actorId: "grabber",
        boundActorId: "grabber",
        roles: ["agent"],
        scope: "capture",
        tokenId: "lib.def",
      },
    });
    // …and an agent-scope credential can't reach the capture surface.
    expect(provider.authenticate(reqWith("env-agent"), "public", "capture")).toEqual({
      ok: false,
      status: 403,
      reason: "wrong-scope",
      principal: {
        kind: "agent",
        actorId: "env-token-agent",
        roles: ["agent"],
        scope: "agent",
      },
    });
  });

  it("valid credential, matching scope → { ok: true } with the bound principal", () => {
    expect(provider.authenticate(reqWith("db-cap"), "public", "capture")).toEqual({
      ok: true,
      principal: {
        kind: "agent",
        actorId: "grabber",
        boundActorId: "grabber",
        roles: ["agent"],
        scope: "capture",
        tokenId: "lib.def",
      },
    });
  });
});

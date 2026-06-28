// ADR 0008 P3: per-surface role resolution — the security core.
//
// Dropping the admin token as a network gate means the role decision MUST be
// made per surface, or the public /mcp listener would grant admin to any caller
// (the trap: "no admin token ⇒ admin"). This suite pins the two invariants:
//
//   - PUBLIC /mcp  : agent-role ONLY. With NO admin token configured a request
//                    resolves to `agent` (when a valid agent token / localhost
//                    bypass applies) or 401 — NEVER `admin`. There is no code
//                    path to admin on this surface.
//   - INTERNAL/trpc: trusted (loopback / internal docker network only, never
//                    published) → `admin` with NO Authorization header.
//
// Unit-tests the auth seam directly (compiled artifact, same as db-tokens.test).

import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { type AuthConfig, authenticateMcp } from "../../dist/http/auth.js";

function reqWith(token?: string): IncomingMessage {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as unknown as IncomingMessage;
}

// A config with NO admin token (the post-P3 default) and an agent token that
// actually gates /mcp. allowNoAuth false = bound beyond localhost.
const noAdminConfig: AuthConfig = {
  agentToken: "env-agent",
  agentTokenMap: new Map(),
  allowedOrigins: [],
  allowNoAuth: false,
  host: "0.0.0.0",
  port: 3838,
};

describe("authenticateMcp — public /mcp is agent-only, NEVER admin (ADR 0008 P3)", () => {
  it("with NO admin token, a valid agent token resolves to agent (never admin)", () => {
    const result = authenticateMcp(reqWith("env-agent"), noAdminConfig, "public");
    expect(result).toEqual({ role: "agent", scope: "agent" });
    expect(result?.role).not.toBe("admin");
  });

  it("with NO admin token and no bearer, a public request is 401 (null) — never admin", () => {
    const result = authenticateMcp(reqWith(), noAdminConfig, "public");
    expect(result).toBeNull();
  });

  it("a wrong agent token beyond localhost is rejected (401/null), never admin", () => {
    const result = authenticateMcp(reqWith("not-the-token"), noAdminConfig, "public");
    expect(result).toBeNull();
  });

  it("the localhost no-auth bypass grants AGENT, never admin", () => {
    const bypass: AuthConfig = { ...noAdminConfig, allowNoAuth: true };
    // No bearer at all on localhost → agent (the bypass), not admin.
    expect(authenticateMcp(reqWith(), bypass, "public")).toEqual({ role: "agent", scope: "agent" });
    // Even a bogus bearer on localhost stays agent — there is NO admin path here.
    expect(authenticateMcp(reqWith("bogus"), bypass, "public")).toEqual({
      role: "agent",
      scope: "agent",
    });
  });

  it("a DB-minted token resolves to agent on /mcp, never admin", () => {
    const config: AuthConfig = {
      ...noAdminConfig,
      verifyDbToken: (t) => (t === "db-tok" ? { agentId: "claude" } : null),
    };
    expect(authenticateMcp(reqWith("db-tok"), config, "public")).toEqual({
      role: "agent",
      agentId: "claude",
      scope: "agent",
    });
  });
});

describe("authenticateMcp — internal /trpc is trusted admin (ADR 0008 P3)", () => {
  it("resolves to admin with NO Authorization header on the internal surface", () => {
    const result = authenticateMcp(reqWith(), noAdminConfig, "internal");
    expect(result).toEqual({ role: "admin" });
  });

  it("resolves to admin even when an agent bearer is present (the socket is the gate)", () => {
    const result = authenticateMcp(reqWith("env-agent"), noAdminConfig, "internal");
    expect(result).toEqual({ role: "admin" });
  });
});

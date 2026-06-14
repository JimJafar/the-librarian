// ADR 0008 P3 regression: the localhost no-auth bypass must fire ONLY when auth
// isn't genuinely in force.
//
// The bug: bin/http.ts computed `allowNoAuth = ALLOW_NO_AUTH || host==127.0.0.1
// || host==localhost`, so on loopback the bypass fired EVEN WITH an agent token
// configured — silently disabling the configured-token gate (auth.ts grants
// `agent` after a failed token match when allowNoAuth is true). A configured
// token must be ENFORCED regardless of host.
//
// resolveAllowNoAuth() is the pure boot-time decision that bin/http.ts feeds into
// AuthConfig.allowNoAuth. These tests pin the six invariants through the real
// resolution + the authenticateMcp seam, so the integration healthcheck has a
// unit-level proof.

import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { type AuthConfig, authenticateMcp, resolveAllowNoAuth } from "../../dist/http/auth.js";

function reqWith(token?: string): IncomingMessage {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as unknown as IncomingMessage;
}

// Build the AuthConfig the way bin/http.ts does, but routing allowNoAuth through
// the real resolver so the test exercises the actual boot-time decision.
function configFor(opts: {
  allowNoAuthEnv?: string;
  host: string;
  agentToken?: string;
  agentTokenMap?: Map<string, string>;
}): AuthConfig {
  const agentToken = opts.agentToken ?? "";
  const agentTokenMap = opts.agentTokenMap ?? new Map();
  return {
    adminToken: "",
    agentToken,
    agentTokenMap,
    allowedOrigins: [],
    allowNoAuth: resolveAllowNoAuth({
      ...(opts.allowNoAuthEnv !== undefined ? { allowNoAuthEnv: opts.allowNoAuthEnv } : {}),
      host: opts.host,
      agentToken,
      agentTokenMap,
    }),
    host: opts.host,
    port: 3838,
  };
}

describe("resolveAllowNoAuth — the loopback bypass only fires when auth isn't in force", () => {
  // Invariant 1 (the bug): a configured token is ENFORCED regardless of host.
  it("token configured + localhost + no ALLOW_NO_AUTH + no bearer → 401", () => {
    const config = configFor({ host: "127.0.0.1", agentToken: "env-agent" });
    expect(config.allowNoAuth).toBe(false);
    expect(authenticateMcp(reqWith(), config, "public")).toBeNull();
  });

  // Invariant 2: a valid bearer on localhost still authenticates.
  it("token configured + localhost + valid bearer → agent (200)", () => {
    const config = configFor({ host: "127.0.0.1", agentToken: "env-agent" });
    expect(authenticateMcp(reqWith("env-agent"), config, "public")).toEqual({ role: "agent" });
  });

  // Invariant 3: the explicit all-in-one opt-in fires even with a token set.
  it("ALLOW_NO_AUTH=true + token configured + no bearer → agent (200)", () => {
    const config = configFor({
      allowNoAuthEnv: "true",
      host: "127.0.0.1",
      agentToken: "env-agent",
    });
    expect(config.allowNoAuth).toBe(true);
    expect(authenticateMcp(reqWith(), config, "public")).toEqual({ role: "agent" });
  });

  // Invariant 4: NEVER open an exposed server with no auth.
  it("no agent auth configured + beyond-localhost + no bearer → 401", () => {
    const config = configFor({ host: "0.0.0.0" });
    expect(config.allowNoAuth).toBe(false);
    expect(authenticateMcp(reqWith(), config, "public")).toBeNull();
  });

  // Invariant 5: zero-config local dev stays open.
  it("no agent auth configured + localhost + no bearer → agent (200)", () => {
    const config = configFor({ host: "127.0.0.1" });
    expect(config.allowNoAuth).toBe(true);
    expect(authenticateMcp(reqWith(), config, "public")).toEqual({ role: "agent" });
    // "localhost" hostname is loopback too.
    const local = configFor({ host: "localhost" });
    expect(local.allowNoAuth).toBe(true);
  });

  // The per-agent map is "configured agent auth" too — same enforcement as a
  // single token (closes the same bypass for the multi-agent path).
  it("agent token MAP configured + localhost + no bearer → 401", () => {
    const config = configFor({
      host: "127.0.0.1",
      agentTokenMap: new Map([["claude", "map-tok"]]),
    });
    expect(config.allowNoAuth).toBe(false);
    expect(authenticateMcp(reqWith(), config, "public")).toBeNull();
    expect(authenticateMcp(reqWith("map-tok"), config, "public")).toEqual({
      role: "agent",
      agentId: "claude",
    });
  });

  // Invariant 6: public /mcp still NEVER resolves to admin, even under the bypass.
  it("public /mcp under the localhost bypass resolves to agent, never admin", () => {
    const config = configFor({ host: "127.0.0.1" });
    const result = authenticateMcp(reqWith(), config, "public");
    expect(result).toEqual({ role: "agent" });
    expect(result?.role).not.toBe("admin");
  });
});

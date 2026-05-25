import {
  createAgentToken,
  listAgentTokens,
  revokeAgentToken,
  verifyAgentToken,
} from "@librarian/core";
import { describe, expect, it } from "vitest";

// A minimal in-memory settings store (the real one is SQLite-backed; agent tokens
// are plain settings — a hash, not a secret — so no master key is involved).
function fakeSettings() {
  const map = new Map<string, string>();
  return {
    setSetting: (key: string, value: string) => map.set(key, value),
    getSetting: (key: string) => map.get(key) ?? null,
    deleteSetting: (key: string) => map.delete(key),
    listSettings: () => [...map.keys()].map((key) => ({ key })),
  };
}

describe("agent tokens", () => {
  it("creates a token that verifies once and returns its agent id", () => {
    const store = fakeSettings();
    const { id, token } = createAgentToken(store, { agentId: "claude", label: "laptop" });
    expect(token.startsWith("lib.")).toBe(true);
    expect(verifyAgentToken(store, token)).toEqual({ agentId: "claude" });
    expect(id.length).toBeGreaterThan(0);
  });

  it("rejects an empty or reserved agentId at mint", () => {
    const store = fakeSettings();
    expect(() => createAgentToken(store, { agentId: "  " })).toThrow(/required/);
    expect(() => createAgentToken(store, { agentId: "system-migration" })).toThrow(/reserved/);
    expect(() => createAgentToken(store, { agentId: "x".repeat(200) })).toThrow(/too long/);
  });

  it("rejects a wrong / malformed token", () => {
    const store = fakeSettings();
    createAgentToken(store, { agentId: "claude" });
    expect(verifyAgentToken(store, "lib.nope.nope")).toBeNull();
    expect(verifyAgentToken(store, "not-a-token")).toBeNull();
    expect(verifyAgentToken(store, "")).toBeNull();
  });

  it("verifies fail after revoke", () => {
    const store = fakeSettings();
    const { id, token } = createAgentToken(store, { agentId: "claude" });
    expect(revokeAgentToken(store, id)).toBe(true);
    expect(verifyAgentToken(store, token)).toBeNull();
    expect(revokeAgentToken(store, id)).toBe(false); // already gone
  });

  it("list returns metadata only — never the secret, hash, or salt", () => {
    const store = fakeSettings();
    createAgentToken(store, { agentId: "claude", label: "a" });
    const metas = listAgentTokens(store);
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({ agentId: "claude", label: "a" });
    const serialized = JSON.stringify(metas);
    expect(serialized).not.toContain("salt");
    expect(serialized).not.toContain("hash");
  });

  it("two tokens for the same agent both verify to that agent", () => {
    const store = fakeSettings();
    const a = createAgentToken(store, { agentId: "claude" });
    const b = createAgentToken(store, { agentId: "claude" });
    expect(a.token).not.toBe(b.token);
    expect(verifyAgentToken(store, a.token)).toEqual({ agentId: "claude" });
    expect(verifyAgentToken(store, b.token)).toEqual({ agentId: "claude" });
    // revoking one leaves the other working
    revokeAgentToken(store, a.id);
    expect(verifyAgentToken(store, a.token)).toBeNull();
    expect(verifyAgentToken(store, b.token)).toEqual({ agentId: "claude" });
  });
});

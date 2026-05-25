import { assertPasswordPolicy, setOwnerPassword, verifyOwnerPassword } from "@librarian/core";
import { describe, expect, it } from "vitest";

// A minimal in-memory settings store. The password record is a one-way hash stored
// as a plain setting (like agent tokens), so no master key is involved.
function fakeSettings() {
  const map = new Map<string, string>();
  return {
    map,
    setSetting: (key: string, value: string) => map.set(key, value),
    getSetting: (key: string) => map.get(key) ?? null,
    deleteSetting: (key: string) => map.delete(key),
    listSettings: () => [...map.keys()].map((key) => ({ key })),
  };
}

const USER = "owner";
const PASSWORD = "correct-horse-battery";

describe("owner password hash/verify (D1.1)", () => {
  it("sets a password that verifies with the right username + password", () => {
    const store = fakeSettings();
    setOwnerPassword(store, USER, PASSWORD);
    expect(verifyOwnerPassword(store, USER, PASSWORD)).toBe(true);
  });

  it("rejects a wrong password", () => {
    const store = fakeSettings();
    setOwnerPassword(store, USER, PASSWORD);
    expect(verifyOwnerPassword(store, USER, "wrong-password-here")).toBe(false);
  });

  it("rejects a wrong username", () => {
    const store = fakeSettings();
    setOwnerPassword(store, USER, PASSWORD);
    expect(verifyOwnerPassword(store, "intruder", PASSWORD)).toBe(false);
  });

  it("returns false when no password is configured", () => {
    const store = fakeSettings();
    expect(verifyOwnerPassword(store, USER, PASSWORD)).toBe(false);
  });

  it("enforces a length floor on set", () => {
    const store = fakeSettings();
    expect(() => setOwnerPassword(store, USER, "short")).toThrow(/length|characters|at least/i);
    expect(() => assertPasswordPolicy("short")).toThrow();
    expect(() => assertPasswordPolicy(PASSWORD)).not.toThrow();
  });

  it("requires a non-empty username", () => {
    const store = fakeSettings();
    expect(() => setOwnerPassword(store, "  ", PASSWORD)).toThrow(/username/i);
  });

  it("stores a one-way hash with its cost params — never the plaintext", () => {
    const store = fakeSettings();
    setOwnerPassword(store, USER, PASSWORD);
    const raw = store.map.get("auth:password") as string;
    expect(raw).not.toContain(PASSWORD);
    const rec = JSON.parse(raw);
    expect(rec.username).toBe(USER);
    expect(rec).toMatchObject({
      N: expect.any(Number),
      r: expect.any(Number),
      p: expect.any(Number),
    });
    expect(typeof rec.salt).toBe("string");
    expect(typeof rec.hash).toBe("string");
    expect(rec).not.toHaveProperty("password");
  });

  it("rehashes with a fresh salt each set (same password → different hash)", () => {
    const a = fakeSettings();
    const b = fakeSettings();
    setOwnerPassword(a, USER, PASSWORD);
    setOwnerPassword(b, USER, PASSWORD);
    expect(a.map.get("auth:password")).not.toBe(b.map.get("auth:password"));
    expect(verifyOwnerPassword(a, USER, PASSWORD)).toBe(true);
    expect(verifyOwnerPassword(b, USER, PASSWORD)).toBe(true);
  });
});

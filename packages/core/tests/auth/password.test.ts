import {
  assertPasswordPolicy,
  authenticateOwner,
  consumeSetupLink,
  getLockoutState,
  mintSetupLink,
  resetLockout,
  setOwnerPassword,
  verifyOwnerPassword,
} from "@librarian/core";
import { describe, expect, it } from "vitest";

// A minimal in-memory settings store. The password record is a one-way hash stored
// as a plain setting (like agent tokens), so no master key is involved. Pass a
// shared map to model a "fresh store handle" over the same persisted state.
function fakeSettings(map: Map<string, string> = new Map()) {
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

describe("owner lockout accounting (D1.2)", () => {
  const t0 = new Date("2026-05-25T12:00:00.000Z");
  function at(msFromT0: number): Date {
    return new Date(t0.getTime() + msFromT0);
  }

  it("locks the account after 5 consecutive failures", () => {
    const store = fakeSettings();
    setOwnerPassword(store, USER, PASSWORD);
    for (let i = 0; i < 4; i++) {
      const r = authenticateOwner(store, USER, "wrong-password-x", at(i * 1000));
      expect(r).toMatchObject({ ok: false, locked: false });
    }
    const fifth = authenticateOwner(store, USER, "wrong-password-x", at(4000));
    expect(fifth.ok).toBe(false);
    expect(fifth.locked).toBe(true);
    expect(fifth.lockedUntil).toBeTruthy();
    expect(getLockoutState(store, at(4000)).failures).toBe(5);
  });

  it("blocks even a correct password while locked, then allows it after the lock expires", () => {
    const store = fakeSettings();
    setOwnerPassword(store, USER, PASSWORD);
    for (let i = 0; i < 5; i++) authenticateOwner(store, USER, "wrong-password-x", at(i * 1000));
    const lockedUntil = getLockoutState(store, at(5000)).lockedUntil as string;

    // Correct password during the lock window is still refused.
    const duringLock = authenticateOwner(store, USER, PASSWORD, at(6000));
    expect(duringLock).toMatchObject({ ok: false, locked: true });

    // After the lock expires, the correct password succeeds and clears the lockout.
    const afterExpiry = new Date(Date.parse(lockedUntil) + 1000);
    const unlocked = authenticateOwner(store, USER, PASSWORD, afterExpiry);
    expect(unlocked.ok).toBe(true);
    expect(getLockoutState(store, afterExpiry).failures).toBe(0);
  });

  it("clears the failure counter on a successful login (below the threshold)", () => {
    const store = fakeSettings();
    setOwnerPassword(store, USER, PASSWORD);
    authenticateOwner(store, USER, "wrong-password-x", at(0));
    authenticateOwner(store, USER, "wrong-password-x", at(1000));
    expect(getLockoutState(store, at(1000)).failures).toBe(2);
    expect(authenticateOwner(store, USER, PASSWORD, at(2000)).ok).toBe(true);
    expect(getLockoutState(store, at(2000)).failures).toBe(0);
  });

  it("persists the lock across a fresh store handle", () => {
    const map = new Map<string, string>();
    const store = fakeSettings(map);
    setOwnerPassword(store, USER, PASSWORD);
    for (let i = 0; i < 5; i++) authenticateOwner(store, USER, "wrong-password-x", at(i * 1000));

    const reopened = fakeSettings(map); // same persisted state, new handle
    expect(getLockoutState(reopened, at(5000)).locked).toBe(true);
  });

  it("resetLockout clears a lock so the owner can log in again", () => {
    const store = fakeSettings();
    setOwnerPassword(store, USER, PASSWORD);
    for (let i = 0; i < 5; i++) authenticateOwner(store, USER, "wrong-password-x", at(i * 1000));
    expect(getLockoutState(store, at(5000)).locked).toBe(true);

    resetLockout(store);
    expect(getLockoutState(store, at(5000)).locked).toBe(false);
    expect(authenticateOwner(store, USER, PASSWORD, at(5000)).ok).toBe(true);
  });

  it("grows the lock exponentially across repeated threshold breaches", () => {
    const store = fakeSettings();
    setOwnerPassword(store, USER, PASSWORD);
    // Measure each lock's duration from the failure that set it, so the reference
    // points match. The 5th failure (at 4000ms) trips the first lock.
    let fifth = { lockedUntil: null as string | null };
    for (let i = 0; i < 5; i++) {
      fifth = authenticateOwner(store, USER, "wrong-password-x", at(i * 1000));
    }
    const firstDuration = Date.parse(fifth.lockedUntil as string) - at(4000).getTime();

    // Let the first lock expire, then fail again within the same window.
    const afterFirst = new Date(Date.parse(fifth.lockedUntil as string) + 1000);
    const sixth = authenticateOwner(store, USER, "wrong-password-x", afterFirst);
    const secondDuration = Date.parse(sixth.lockedUntil as string) - afterFirst.getTime();

    expect(secondDuration).toBe(firstDuration * 2);
  });
});

describe("one-time setup links (D1.3)", () => {
  const TTL = 15 * 60_000;
  const t0 = new Date("2026-05-25T12:00:00.000Z");

  it("mints a token that consumes exactly once (replay rejected)", () => {
    const store = fakeSettings();
    const token = mintSetupLink(store, TTL, t0);
    expect(token.startsWith("libsetup.")).toBe(true);
    expect(consumeSetupLink(store, token, new Date(t0.getTime() + 1000))).toBe(true);
    // Second use of the same token is refused.
    expect(consumeSetupLink(store, token, new Date(t0.getTime() + 2000))).toBe(false);
  });

  it("rejects an expired token", () => {
    const store = fakeSettings();
    const token = mintSetupLink(store, TTL, t0);
    const afterExpiry = new Date(t0.getTime() + TTL + 1000);
    expect(consumeSetupLink(store, token, afterExpiry)).toBe(false);
  });

  it("rejects a wrong / malformed token", () => {
    const store = fakeSettings();
    mintSetupLink(store, TTL, t0);
    expect(consumeSetupLink(store, "libsetup.nope.nope", new Date(t0.getTime() + 1000))).toBe(
      false,
    );
    expect(consumeSetupLink(store, "not-a-token", new Date(t0.getTime() + 1000))).toBe(false);
    expect(consumeSetupLink(store, "", new Date(t0.getTime() + 1000))).toBe(false);
  });

  it("stores only a hash — never the plaintext secret", () => {
    const store = fakeSettings();
    const token = mintSetupLink(store, TTL, t0);
    const secret = token.split(".")[2];
    const serialized = JSON.stringify([...store.map.values()]);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("secret");
  });
});

import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BootstrapClaimTokenError,
  assertBootstrapClaimSecret,
  createBootstrapClaimHandle,
  createInertBootstrapClaimHandle,
  isAuthUnowned,
  mintBootstrapClaim,
  mintBootstrapClaimReceipt,
  readBootstrapClaimBurn,
  setEnabled,
  setOwnerPassword,
  verifyBootstrapClaim,
  verifyBootstrapClaimReceipt,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SECRET = "bootstrap-claim-test-secret-".repeat(2);
const OTHER_SECRET = "different-bootstrap-test-secret-".repeat(2);
const NOW = new Date("2026-07-18T12:00:00.000Z");
const EMAIL = "owner@example.com";

function fakeSettings(map: Map<string, string> = new Map()) {
  return {
    map,
    setSetting: (key: string, value: string) => map.set(key, value),
    getSetting: (key: string) => map.get(key) ?? null,
    deleteSetting: (key: string) => map.delete(key),
    listSettings: () => [...map.keys()].map((key) => ({ key })),
  };
}

function signRawClaims(claims: unknown, secret = SECRET): string {
  const bytes = Buffer.from(JSON.stringify(claims));
  const payload = bytes.toString("base64url");
  const mac = createHmac("sha256", secret).update(bytes).digest("base64url");
  return `v1.${payload}.${mac}`;
}

function claim(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    purpose: "bootstrap-claim",
    email: EMAIL,
    exp: Math.floor(NOW.getTime() / 1000) + 15 * 60,
    ...overrides,
  };
}

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-bootstrap-claim-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("bootstrap claim token contract", () => {
  it("round-trips a claim and normalises the owner email at mint and verify", () => {
    const token = mintBootstrapClaim(
      SECRET,
      {
        email: "  Owner@Example.COM ",
        expiresAt: new Date(NOW.getTime() + 15 * 60_000),
        returnTo: "https://console.example/claimed?tenant=one",
      },
      NOW,
    );

    expect(verifyBootstrapClaim(SECRET, token, NOW)).toEqual({
      v: 1,
      purpose: "bootstrap-claim",
      email: EMAIL,
      exp: Math.floor(NOW.getTime() / 1000) + 15 * 60,
      returnTo: "https://console.example/claimed?tenant=one",
    });
  });

  it.each([
    ["wrong prefix", (token: string) => token.replace(/^v1/, "v2")],
    [
      "tampered claims",
      (token: string) => {
        const [, payload, mac] = token.split(".");
        const parsed = JSON.parse(Buffer.from(payload ?? "", "base64url").toString()) as Record<
          string,
          unknown
        >;
        parsed.email = "intruder@example.com";
        return `v1.${Buffer.from(JSON.stringify(parsed)).toString("base64url")}.${mac}`;
      },
    ],
    ["tampered MAC", (token: string) => `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`],
  ])("refuses a %s", (_label, mutate) => {
    const token = mintBootstrapClaim(
      SECRET,
      { email: EMAIL, expiresAt: new Date(NOW.getTime() + 15 * 60_000) },
      NOW,
    );

    expect(() => verifyBootstrapClaim(SECRET, mutate(token), NOW)).toThrow(
      BootstrapClaimTokenError,
    );
  });

  it("rejects unknown claim keys rather than accepting an open-ended payload", () => {
    expect(() =>
      verifyBootstrapClaim(SECRET, signRawClaims(claim({ role: "admin" })), NOW),
    ).toThrow(/invalid/i);
  });

  it("distinguishes a valid expired claim but keeps an excessive future expiry generic", () => {
    const expired = signRawClaims(claim({ exp: Math.floor(NOW.getTime() / 1000) - 1 }));
    const tooFar = signRawClaims(claim({ exp: Math.floor(NOW.getTime() / 1000) + 86_401 }));

    try {
      verifyBootstrapClaim(SECRET, expired, NOW);
      expect.unreachable("expired claim should throw");
    } catch (error) {
      expect(error).toMatchObject({ code: "expired", message: "claim expired" });
    }
    try {
      verifyBootstrapClaim(SECRET, tooFar, NOW);
      expect.unreachable("overlong claim should throw");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid", message: "claim invalid" });
    }
  });

  it("rejects an implausible email, an incorrect secret, and malformed encodings", () => {
    const token = signRawClaims(claim());

    expect(() =>
      verifyBootstrapClaim(SECRET, signRawClaims(claim({ email: "not-an-email" })), NOW),
    ).toThrow(/invalid/i);
    expect(() => verifyBootstrapClaim(OTHER_SECRET, token, NOW)).toThrow(/invalid/i);
    expect(() => verifyBootstrapClaim(SECRET, "v1.%%%%.%%%%", NOW)).toThrow(/invalid/i);
  });

  it("MACs the transmitted claim bytes instead of reserialising parsed JSON", () => {
    const claimsWithWhitespace = Buffer.from(
      `{\n  "v": 1,\n  "purpose": "bootstrap-claim",\n  "email": "${EMAIL}",\n  "exp": ${
        Math.floor(NOW.getTime() / 1000) + 900
      }\n}`,
    );
    const payload = claimsWithWhitespace.toString("base64url");
    const mac = createHmac("sha256", SECRET).update(claimsWithWhitespace).digest("base64url");

    expect(verifyBootstrapClaim(SECRET, `v1.${payload}.${mac}`, NOW).email).toBe(EMAIL);
  });

  it("keeps receipt and claim purposes non-interchangeable", () => {
    const claimToken = mintBootstrapClaim(
      SECRET,
      { email: EMAIL, expiresAt: new Date(NOW.getTime() + 15 * 60_000) },
      NOW,
    );
    const receipt = mintBootstrapClaimReceipt(SECRET, {
      email: EMAIL,
      claimedAt: NOW.toISOString(),
    });

    expect(verifyBootstrapClaimReceipt(SECRET, receipt)).toEqual({
      v: 1,
      purpose: "claim-receipt",
      email: EMAIL,
      claimedAt: NOW.toISOString(),
    });
    expect(() => verifyBootstrapClaim(SECRET, receipt, NOW)).toThrow(/invalid/i);
    expect(() => verifyBootstrapClaimReceipt(SECRET, claimToken)).toThrow(/invalid/i);
  });

  it("never includes token or secret material in verification errors", () => {
    const token = signRawClaims(claim(), OTHER_SECRET);

    let caught: unknown;
    try {
      verifyBootstrapClaim(SECRET, token, NOW);
    } catch (error) {
      caught = error;
    }
    const rendered = String(caught);
    expect(rendered).not.toContain(token);
    expect(rendered).not.toContain(SECRET);
    expect(rendered).not.toContain(OTHER_SECRET);
  });
});

describe("bootstrap claim lifecycle predicates", () => {
  it("writes and reads the persistent burn receipt with owner-only permissions", () => {
    const handle = createBootstrapClaimHandle({ dataDir, secret: SECRET });

    handle.burn(EMAIL, NOW);

    expect(readBootstrapClaimBurn(dataDir)).toEqual({
      claimedAt: NOW.toISOString(),
      email: EMAIL,
    });
    const mode = fs.statSync(path.join(dataDir, "bootstrap-claim.json")).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(handle.isBurned()).toBe(true);
  });

  it("refuses all claims once burned, independently of token validity", () => {
    const store = fakeSettings();
    const handle = createBootstrapClaimHandle({ dataDir, secret: SECRET });
    handle.burn(EMAIL, NOW);

    expect(handle.claimPending(store)).toBe(false);
    expect(handle.isBurned()).toBe(true);
  });

  it("treats enabled auth as owned even if the burn flag is absent", () => {
    const store = fakeSettings();
    const handle = createBootstrapClaimHandle({ dataDir, secret: SECRET });
    setEnabled(store, true);

    expect(isAuthUnowned(store)).toBe(false);
    expect(handle.claimPending(store)).toBe(false);
  });

  it("keeps a password-set but disabled instance unowned and claimable", () => {
    const store = fakeSettings();
    const handle = createBootstrapClaimHandle({ dataDir, secret: SECRET });
    setOwnerPassword(store, "old-owner", "correct-horse-battery");

    expect(isAuthUnowned(store)).toBe(true);
    expect(handle.claimPending(store)).toBe(true);
  });

  it("provides an inert handle that neither reads disk nor settings", () => {
    const inert = createInertBootstrapClaimHandle();
    const explosiveStore = {
      setSetting: () => {
        throw new Error("must not be consulted");
      },
      getSetting: () => {
        throw new Error("must not be consulted");
      },
      listSettings: () => {
        throw new Error("must not be consulted");
      },
    };

    expect(inert.armed).toBe(false);
    expect(inert.claimPending(explosiveStore)).toBe(false);
  });
});

describe("bootstrap claim secret validation", () => {
  it("accepts 32 characters and rejects anything shorter without echoing it", () => {
    expect(() => assertBootstrapClaimSecret("x".repeat(32))).not.toThrow();
    try {
      assertBootstrapClaimSecret("short");
      expect.unreachable("short secret should throw");
    } catch (error) {
      expect(String(error)).toContain("at least 32 characters");
      expect(String(error)).not.toContain('"short"');
    }
  });
});

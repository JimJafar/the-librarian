import { describe, expect, it } from "vitest";
import { displayEmailFromClaimToken } from "@/lib/claim-token-display";

function displayToken(payload: unknown, mac = "not-verified-in-the-browser"): string {
  return `v1.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${mac}`;
}

describe("claim token display decoder", () => {
  it("reads the prefilled email without pretending to verify the claim", () => {
    expect(
      displayEmailFromClaimToken(
        displayToken({
          v: 1,
          purpose: "bootstrap-claim",
          email: "owner@example.com",
          exp: 1,
        }),
      ),
    ).toBe("owner@example.com");
  });

  it.each([
    "",
    "not-a-token",
    "v2.e30.mac",
    "v1.not-base64.mac",
    displayToken({ email: 42 }),
    displayToken({ email: "x".repeat(321) }),
  ])("returns null for a malformed display payload", (token) => {
    expect(displayEmailFromClaimToken(token)).toBeNull();
  });

  it("bounds the untrusted URL value before decoding it", () => {
    expect(displayEmailFromClaimToken(`v1.${"a".repeat(9000)}.mac`)).toBeNull();
  });
});

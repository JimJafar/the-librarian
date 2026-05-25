import { describe, expect, it } from "vitest";
import { isAllowedOwner } from "@/lib/owner-allowlist";

// A1: single-owner allowlist. The signIn callback delegates here; this is the
// security gate, so the table below is the contract — deny by default, match by
// provider account id, email as a documented fallback.
describe("isAllowedOwner", () => {
  it("allows the configured GitHub account id", () => {
    expect(
      isAllowedOwner(
        { provider: "github", accountId: "12345", email: "owner@example.com" },
        { LIBRARIAN_OWNER_GITHUB_ID: "12345" },
      ),
    ).toBe(true);
  });

  it("denies a different GitHub account id", () => {
    expect(
      isAllowedOwner(
        { provider: "github", accountId: "99999" },
        { LIBRARIAN_OWNER_GITHUB_ID: "12345" },
      ),
    ).toBe(false);
  });

  it("allows the configured Google account id (sub)", () => {
    expect(
      isAllowedOwner(
        { provider: "google", accountId: "sub-abc" },
        { LIBRARIAN_OWNER_GOOGLE_ID: "sub-abc" },
      ),
    ).toBe(true);
  });

  it("does not let a GitHub id satisfy the Google allowlist (provider-scoped)", () => {
    // Same string, wrong provider — must not match.
    expect(
      isAllowedOwner(
        { provider: "github", accountId: "shared" },
        { LIBRARIAN_OWNER_GOOGLE_ID: "shared" },
      ),
    ).toBe(false);
  });

  it("allows a VERIFIED allowlisted email, case-insensitively, from any provider", () => {
    expect(
      isAllowedOwner(
        { provider: "google", accountId: "x", email: "Owner@Example.com", emailVerified: true },
        { LIBRARIAN_OWNER_EMAILS: "owner@example.com, other@example.com" },
      ),
    ).toBe(true);
  });

  it("denies an UNVERIFIED email even if it is on the allowlist (takeover guard)", () => {
    // An attacker can set the owner's address as an unverified profile email.
    expect(
      isAllowedOwner(
        { provider: "github", accountId: "999", email: "owner@example.com", emailVerified: false },
        { LIBRARIAN_OWNER_EMAILS: "owner@example.com" },
      ),
    ).toBe(false);
    // Absent verification flag is treated as unverified.
    expect(
      isAllowedOwner(
        { provider: "github", accountId: "999", email: "owner@example.com" },
        { LIBRARIAN_OWNER_EMAILS: "owner@example.com" },
      ),
    ).toBe(false);
  });

  it("matches the id branch regardless of provider-string casing", () => {
    expect(
      isAllowedOwner(
        { provider: "GitHub", accountId: "12345" },
        { LIBRARIAN_OWNER_GITHUB_ID: "12345" },
      ),
    ).toBe(true);
  });

  it("denies by default when nothing is configured", () => {
    expect(isAllowedOwner({ provider: "github", accountId: "12345", email: "a@b.com" }, {})).toBe(
      false,
    );
  });

  it("treats empty / whitespace-only config as unconfigured (no empty-matches-empty hole)", () => {
    // Empty config + empty input must NOT match.
    expect(
      isAllowedOwner({ provider: "github", accountId: "" }, { LIBRARIAN_OWNER_GITHUB_ID: "" }),
    ).toBe(false);
    // Whitespace-only id is not a valid owner.
    expect(
      isAllowedOwner({ provider: "github", accountId: "  " }, { LIBRARIAN_OWNER_GITHUB_ID: "  " }),
    ).toBe(false);
    // Whitespace-only email config + verified empty email must NOT match.
    expect(
      isAllowedOwner(
        { provider: "google", email: "", emailVerified: true },
        { LIBRARIAN_OWNER_EMAILS: "  ," },
      ),
    ).toBe(false);
  });

  it("denies when the id/email is missing even though config exists", () => {
    expect(isAllowedOwner({ provider: "github" }, { LIBRARIAN_OWNER_GITHUB_ID: "12345" })).toBe(
      false,
    );
    expect(
      isAllowedOwner(
        { provider: "google", email: null, emailVerified: true },
        { LIBRARIAN_OWNER_EMAILS: "a@b.com" },
      ),
    ).toBe(false);
  });
});

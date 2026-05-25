import { describe, expect, it } from "vitest";
import { isAllowedOwner, resolveOwnerAllowlist } from "@/lib/owner-allowlist";

// A1/D2.3: single-owner allowlist. The signIn callback delegates here; this is the
// security gate, so the table below is the contract — deny by default, match by
// provider account id, email as a documented fallback. The allowlist is now a
// resolved shape (from store config or legacy env).
describe("isAllowedOwner", () => {
  it("allows the configured GitHub account id", () => {
    expect(isAllowedOwner({ provider: "github", accountId: "12345" }, { githubId: "12345" })).toBe(
      true,
    );
  });

  it("denies a different GitHub account id", () => {
    expect(isAllowedOwner({ provider: "github", accountId: "99999" }, { githubId: "12345" })).toBe(
      false,
    );
  });

  it("allows the configured Google account id (sub)", () => {
    expect(
      isAllowedOwner({ provider: "google", accountId: "sub-abc" }, { googleId: "sub-abc" }),
    ).toBe(true);
  });

  it("does not let a GitHub id satisfy the Google allowlist (provider-scoped)", () => {
    expect(
      isAllowedOwner({ provider: "github", accountId: "shared" }, { googleId: "shared" }),
    ).toBe(false);
  });

  it("allows a VERIFIED allowlisted email, case-insensitively, from any provider", () => {
    expect(
      isAllowedOwner(
        { provider: "google", accountId: "x", email: "Owner@Example.com", emailVerified: true },
        { emails: ["owner@example.com", "other@example.com"] },
      ),
    ).toBe(true);
  });

  it("denies an UNVERIFIED email even if it is on the allowlist (takeover guard)", () => {
    expect(
      isAllowedOwner(
        { provider: "github", accountId: "999", email: "owner@example.com", emailVerified: false },
        { emails: ["owner@example.com"] },
      ),
    ).toBe(false);
    expect(
      isAllowedOwner(
        { provider: "github", accountId: "999", email: "owner@example.com" },
        { emails: ["owner@example.com"] },
      ),
    ).toBe(false);
  });

  it("matches the id branch regardless of provider-string casing", () => {
    expect(isAllowedOwner({ provider: "GitHub", accountId: "12345" }, { githubId: "12345" })).toBe(
      true,
    );
  });

  it("denies by default when nothing is configured", () => {
    expect(isAllowedOwner({ provider: "github", accountId: "12345", email: "a@b.com" }, {})).toBe(
      false,
    );
  });

  it("treats empty / whitespace-only config as unconfigured (no empty-matches-empty hole)", () => {
    expect(isAllowedOwner({ provider: "github", accountId: "" }, { githubId: "" })).toBe(false);
    expect(isAllowedOwner({ provider: "github", accountId: "  " }, { githubId: "  " })).toBe(false);
    expect(
      isAllowedOwner(
        { provider: "google", email: "", emailVerified: true },
        { emails: ["  ", ""] },
      ),
    ).toBe(false);
  });

  it("denies when the id/email is missing even though config exists", () => {
    expect(isAllowedOwner({ provider: "github" }, { githubId: "12345" })).toBe(false);
    expect(
      isAllowedOwner(
        { provider: "google", email: null, emailVerified: true },
        { emails: ["a@b.com"] },
      ),
    ).toBe(false);
  });
});

describe("resolveOwnerAllowlist (config wins, env fallback)", () => {
  it("uses the store config's OAuth owner ids when present", () => {
    const allowlist = resolveOwnerAllowlist(
      { ownerOAuth: { github: "store-gh", google: "store-goog" } },
      { LIBRARIAN_OWNER_GITHUB_ID: "env-gh" },
    );
    expect(allowlist).toEqual({ githubId: "store-gh", googleId: "store-goog" });
  });

  it("falls back to legacy env when the config has no owner", () => {
    const allowlist = resolveOwnerAllowlist(
      { ownerOAuth: {} },
      { LIBRARIAN_OWNER_GITHUB_ID: "env-gh", LIBRARIAN_OWNER_EMAILS: "a@b.com" },
    );
    expect(allowlist.githubId).toBe("env-gh");
    expect(allowlist.emails).toEqual(["a@b.com"]);
  });

  it("falls back to env when config is null (unconfigured store)", () => {
    const allowlist = resolveOwnerAllowlist(null, { LIBRARIAN_OWNER_GOOGLE_ID: "env-goog" });
    expect(allowlist.googleId).toBe("env-goog");
  });
});

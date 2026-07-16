import {
  DASHBOARD_USER_HEADER as SERVER_HEADER,
  DASHBOARD_USER_POISON as SERVER_POISON,
  readDashboardUser,
} from "@librarian/mcp-server/extension";
import { describe, expect, it } from "vitest";
// The server-side contract half — imported to PIN that the dashboard's local constants and the
// server's exported ones cannot drift (the setter and reader must agree byte-for-byte).
import {
  DASHBOARD_USER_HEADER,
  DASHBOARD_USER_POISON,
  anonymousAssertion,
  encodeDashboardAssertion,
  hasSessionCookie,
  userClaimsFromSession,
} from "@/lib/dashboard-assertion";

describe("dashboard-assertion — drift guard against the server contract", () => {
  it("the dashboard's header name equals the server's exported constant", () => {
    expect(DASHBOARD_USER_HEADER).toBe(SERVER_HEADER);
  });

  it("the dashboard's poison marker equals the server's exported constant", () => {
    expect(DASHBOARD_USER_POISON).toBe(SERVER_POISON);
  });
});

describe("dashboard-assertion — the setter round-trips through the server reader", () => {
  // The setter encodes with TextEncoder/btoa; the reader decodes with Node's Buffer base64url.
  // These tests prove the two independent base64url implementations agree.
  function readBack(headerValue: string) {
    return readDashboardUser({ headers: { [DASHBOARD_USER_HEADER]: headerValue } });
  }

  it("a user assertion encodes and decodes to the same claims", () => {
    const encoded = encodeDashboardAssertion({ provider: "github", sub: "12345" });
    expect(readBack(encoded)).toEqual({
      kind: "user",
      user: { provider: "github", sub: "12345" },
    });
  });

  it("a non-latin1 display name survives the hop (base64url, not raw JSON — ByteString safety)", () => {
    const encoded = encodeDashboardAssertion({ provider: "google", sub: "9", name: "名前" });
    expect(readBack(encoded)).toEqual({
      kind: "user",
      user: { provider: "google", sub: "9", name: "名前" },
    });
  });

  it("the anonymous assertion decodes to `anonymous`", () => {
    expect(readBack(anonymousAssertion())).toEqual({ kind: "anonymous" });
  });

  it("oversize claims yield the poison marker (never an oversize header, never omitted)", () => {
    const value = encodeDashboardAssertion({ provider: "github", sub: "x".repeat(6000) });
    expect(value).toBe(DASHBOARD_USER_POISON);
    expect(readBack(value)).toEqual({ kind: "invalid" });
  });
});

describe("userClaimsFromSession", () => {
  it("returns claims when provider + sub are both present", () => {
    expect(
      userClaimsFromSession({ provider: "github", sub: "1", email: "a@b.c", name: "Owner" }),
    ).toEqual({ provider: "github", sub: "1", email: "a@b.c", name: "Owner" });
  });

  it("omits absent optional fields", () => {
    expect(userClaimsFromSession({ provider: "github", sub: "1" })).toEqual({
      provider: "github",
      sub: "1",
    });
  });

  it("returns null when the stable subject is incomplete (no provider or no sub)", () => {
    expect(userClaimsFromSession({ sub: "1" })).toBeNull();
    expect(userClaimsFromSession({ provider: "github" })).toBeNull();
    expect(userClaimsFromSession({ provider: "  ", sub: "1" })).toBeNull();
    expect(userClaimsFromSession({})).toBeNull();
  });
});

describe("hasSessionCookie — prefix detection incl. chunk suffixes (SC 3 chunking fact)", () => {
  it("detects the plain non-secure and secure session cookies", () => {
    expect(hasSessionCookie(["authjs.session-token"])).toBe(true);
    expect(hasSessionCookie(["__Secure-authjs.session-token"])).toBe(true);
  });

  it("detects a CHUNKED session cookie by name prefix (name.0, name.1, …)", () => {
    expect(hasSessionCookie(["authjs.session-token.0", "authjs.session-token.1"])).toBe(true);
    expect(hasSessionCookie(["__Secure-authjs.session-token.0"])).toBe(true);
  });

  it("does not match unrelated cookies", () => {
    expect(hasSessionCookie(["authjs.csrf-token", "theme"])).toBe(false);
    expect(hasSessionCookie([])).toBe(false);
    // A lookalike that is neither the exact name nor a chunk suffix.
    expect(hasSessionCookie(["authjs.session-tokenX"])).toBe(false);
  });
});

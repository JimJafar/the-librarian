import { describe, expect, it } from "vitest";
import { isAuthEnforced } from "@/lib/auth-gate";

// A2: enforcement is feature-flagged so login can be wired (A1) before it is
// enforced — no slice can lock the owner out mid-rollout.
describe("isAuthEnforced", () => {
  it("is on only for the exact string 'true'", () => {
    expect(isAuthEnforced({ LIBRARIAN_AUTH_ENABLED: "true" })).toBe(true);
  });

  it("is off when unset, empty, or any other value", () => {
    expect(isAuthEnforced({})).toBe(false);
    expect(isAuthEnforced({ LIBRARIAN_AUTH_ENABLED: "" })).toBe(false);
    expect(isAuthEnforced({ LIBRARIAN_AUTH_ENABLED: "false" })).toBe(false);
    expect(isAuthEnforced({ LIBRARIAN_AUTH_ENABLED: "1" })).toBe(false);
    expect(isAuthEnforced({ LIBRARIAN_AUTH_ENABLED: "TRUE" })).toBe(false);
  });
});

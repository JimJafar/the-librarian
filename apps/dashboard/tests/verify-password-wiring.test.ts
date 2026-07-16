import { afterEach, describe, expect, it, vi } from "vitest";

// spec 065 SC 3 / review finding F1: the owner-password verify is the third sessionless bootstrap
// flow and MUST ride the BARE client — a sessionless, pre-session call on the identity-bearing
// serverTRPC would assert anonymity and break sign-in under a member-aware provider. The other two
// bootstrap flows (config fetch, reset redemption) are regression-pinned; this pins the third. The
// seam lives in its own module (lib/verify-owner-password.ts) precisely so it can be imported here
// without dragging in NextAuth — a revert of the wiring back to serverTRPC fails this loudly.

const bareVerifyMock = vi.fn(async () => ({ ok: true }));
const identityVerifyMock = vi.fn(async () => ({ ok: true }));

vi.mock("@/lib/trpc-server-bare", () => ({
  bareServerTRPC: { auth: { verifyPassword: { mutate: bareVerifyMock } } },
}));
// If the seam regresses to the identity client, THIS mock's mutate fires and the assertion catches
// it. Mocked wholesale so no real client / module-init side effect runs.
vi.mock("@/lib/trpc-server", () => ({
  serverTRPC: { auth: { verifyPassword: { mutate: identityVerifyMock } } },
}));

const { verifyOwnerPassword } = await import("../lib/verify-owner-password");

describe("owner-password verify wiring (spec 065 SC 3)", () => {
  afterEach(() => {
    bareVerifyMock.mockClear();
    identityVerifyMock.mockClear();
  });

  it("verifies through the BARE bootstrap client, never the identity client", async () => {
    const result = await verifyOwnerPassword("owner", "a-good-password");
    expect(result).toEqual({ ok: true });
    expect(bareVerifyMock).toHaveBeenCalledWith({ username: "owner", password: "a-good-password" });
    expect(identityVerifyMock).not.toHaveBeenCalled();
  });
});

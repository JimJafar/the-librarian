import { afterEach, describe, expect, it, vi } from "vitest";

// D4.3: the reset page's server action redeems a one-time setup link via the admin
// tRPC client. The link's single-use/expiry semantics live in core + the tRPC
// procedure (tested there); here we pin the action's wiring and error mapping.
//
// spec 065 SC 3 moved this action to the BARE bootstrap client (its credential is the one-time
// link token; a sessionless action on the identity client would assert anonymity and break
// break-glass recovery under a member-aware provider), so the mock pins THAT client. The
// assertions are unchanged from the pre-065 wiring test.

const redeemMock = vi.fn();

vi.mock("@/lib/trpc-server-bare", () => ({
  bareServerTRPC: { auth: { redeemSetupLink: { mutate: redeemMock } } },
}));

const actions = await import("../app/settings/auth/reset/actions");

// Not a `password: "literal"` (avoids tripping secret scanners on a test fixture).
const PW = "a-good-password";

describe("reset actions", () => {
  afterEach(() => redeemMock.mockReset());

  it("redeems the link and returns ok", async () => {
    redeemMock.mockResolvedValue({ ok: true });
    const res = await actions.redeemResetAction({
      token: "libsetup.a.b",
      password: PW,
    });
    expect(res).toEqual({ ok: true });
    expect(redeemMock).toHaveBeenCalledWith({ token: "libsetup.a.b", password: PW });
  });

  it("forwards a trimmed username when provided", async () => {
    redeemMock.mockResolvedValue({ ok: true });
    await actions.redeemResetAction({
      token: "t",
      username: "  owner  ",
      password: PW,
    });
    expect(redeemMock).toHaveBeenCalledWith({
      token: "t",
      password: PW,
      username: "owner",
    });
  });

  it("maps a rejected (expired/used) link to an error result", async () => {
    redeemMock.mockRejectedValue(new Error("setup link is invalid, expired, or already used"));
    const res = await actions.redeemResetAction({ token: "t", password: PW });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/invalid|expired|used/i);
  });
});

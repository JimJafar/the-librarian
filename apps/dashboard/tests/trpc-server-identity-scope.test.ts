import { describe, expect, it } from "vitest";

// spec 065 SC 3 — the scope discriminator PINNED against the INSTALLED `next`.
//
// The identity callback's row 4 (no request scope → NO header) is keyed on ONE error shape:
// Next's outside-request-scope throw from `cookies()`. This file deliberately does NOT mock
// `next/headers`: it calls the real `cookies()` in a bare Node test process (no request scope)
// and pins the error's documented shape (`__NEXT_ERROR_CODE === "E251"` + the message), so a
// `next` upgrade that changes the shape FAILS LOUDLY here — instead of silently routing every
// probe throw down the re-throw path (an availability regression) or, worse, a widened matcher
// mapping the wrong error class to machine trust.

describe("the outside-request-scope error shape (installed next)", () => {
  it("cookies() outside a request scope throws the pinned E251 shape", async () => {
    const { cookies } = await import("next/headers");
    let thrown: unknown;
    try {
      await cookies();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error & { __NEXT_ERROR_CODE?: unknown };
    // BOTH signals of the documented shape — if either changes on a version bump, this fails
    // loudly and the matcher in lib/trpc-server.ts must be re-grounded.
    expect(error.__NEXT_ERROR_CODE).toBe("E251");
    expect(error.message).toContain("was called outside a request scope");
  });

  it("the identity callback maps that real error to NO header, without throwing (row 4)", async () => {
    const { dashboardIdentityHeaders } = await import("@/lib/trpc-server");

    // No request scope exists in this test process, so the real probe throws the real E251 —
    // the ONLY throw allow-listed to mean "machine context".
    await expect(dashboardIdentityHeaders()).resolves.toEqual({});
  });
});

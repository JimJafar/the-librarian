import { describe, expect, it } from "vitest";
import { createRateLimiter } from "@/lib/rate-limit";

// D3.2: a small in-memory sliding-window limiter — defense in depth on the
// credentials route, atop the authoritative store-side lockout.

describe("createRateLimiter", () => {
  it("allows up to the limit within the window, then throttles", () => {
    const now = 0;
    const limiter = createRateLimiter({ limit: 3, windowMs: 1000, now: () => now });
    expect(limiter.check("ip")).toBe(true);
    expect(limiter.check("ip")).toBe(true);
    expect(limiter.check("ip")).toBe(true);
    expect(limiter.check("ip")).toBe(false); // 4th over the limit
  });

  it("resets after the window elapses", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => now });
    expect(limiter.check("ip")).toBe(true);
    expect(limiter.check("ip")).toBe(true);
    expect(limiter.check("ip")).toBe(false);
    now += 1001; // window passed
    expect(limiter.check("ip")).toBe(true);
  });

  it("tracks keys independently", () => {
    const now = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => now });
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("a")).toBe(false);
    expect(limiter.check("b")).toBe(true); // different key, own budget
  });
});

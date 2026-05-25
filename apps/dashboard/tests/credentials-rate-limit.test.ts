import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// D3.2: the credentials callback route is rate-limited (defense in depth on top of
// the store-side lockout). A burst over the limit is throttled with a generic 429;
// other auth routes pass straight through.

const postMock = vi.fn();
vi.mock("@/auth", () => ({
  handlers: { GET: vi.fn(), POST: (req: NextRequest) => postMock(req) },
}));

const { POST } = await import("@/app/api/auth/[...nextauth]/route");

function credentialsRequest(ip = "1.2.3.4"): NextRequest {
  return new NextRequest("http://localhost:3000/api/auth/callback/credentials", {
    method: "POST",
    headers: { "x-forwarded-for": ip },
  });
}

beforeEach(() => {
  postMock.mockReset();
  postMock.mockResolvedValue(new Response("ok", { status: 200 }));
});
afterEach(() => vi.clearAllMocks());

describe("/api/auth credentials rate limit", () => {
  it("passes requests under the limit through to NextAuth", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await POST(credentialsRequest());
      expect(res.status).toBe(200);
    }
    expect(postMock).toHaveBeenCalledTimes(10);
  });

  it("throttles a burst over the limit with a generic 429 (no enumeration)", async () => {
    for (let i = 0; i < 10; i++) await POST(credentialsRequest("9.9.9.9"));
    postMock.mockClear();

    const res = await POST(credentialsRequest("9.9.9.9"));
    expect(res.status).toBe(429);
    expect(postMock).not.toHaveBeenCalled(); // never reaches NextAuth / the store
    const body = await res.text();
    expect(body).not.toMatch(/lock|user|password/i); // generic, no enumeration
  });

  it("does not rate-limit non-credentials auth routes", async () => {
    const sessionReq = new NextRequest("http://localhost:3000/api/auth/session", {
      method: "POST",
    });
    for (let i = 0; i < 20; i++) {
      const res = await POST(sessionReq);
      expect(res.status).toBe(200);
    }
    expect(postMock).toHaveBeenCalledTimes(20);
  });
});

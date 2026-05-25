import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A2 (critical): the /api/trpc proxy injects the admin bearer token server-side,
// so middleware-only gating is not enough — the proxy must ALSO require a session
// when auth is enforced, or the dashboard's admin power stays reachable without
// one. These tests pin that gate.

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: () => authMock() }));

const { POST } = await import("@/app/api/trpc/[trpc]/route");

const params = { params: Promise.resolve({ trpc: "curator.config" }) };

function proxyRequest(): NextRequest {
  return new NextRequest("http://localhost:3000/api/trpc/curator.config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  authMock.mockReset();
  fetchSpy = vi.fn(async () => new Response('{"result":{"data":null}}', { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
  process.env.LIBRARIAN_ADMIN_TOKEN = "admin-token";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LIBRARIAN_AUTH_ENABLED;
});

describe("/api/trpc proxy session gate", () => {
  it("401s when auth is enforced and there is no session — without reaching upstream", async () => {
    process.env.LIBRARIAN_AUTH_ENABLED = "true";
    authMock.mockResolvedValue(null);

    const res = await POST(proxyRequest(), params);

    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled(); // admin token never leaves the box
  });

  it("proxies through when auth is enforced and a session is present", async () => {
    process.env.LIBRARIAN_AUTH_ENABLED = "true";
    authMock.mockResolvedValue({ user: { name: "owner" } });

    const res = await POST(proxyRequest(), params);

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const sent = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect((sent.headers as Headers).get("authorization")).toBe("Bearer admin-token");
  });

  it("proxies through when auth is disabled (backward compatible), never calling auth()", async () => {
    // flag unset
    const res = await POST(proxyRequest(), params);

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(authMock).not.toHaveBeenCalled();
  });
});

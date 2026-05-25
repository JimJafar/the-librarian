import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A2 (critical): the /api/trpc proxy injects the admin bearer token server-side,
// so middleware-only gating is not enough — the proxy must ALSO require a session
// when auth is enforced, or the dashboard's admin power stays reachable without
// one. These tests pin that gate.

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: () => authMock() }));

// D2.4: the proxy gates on the store-driven enforcement decision. Mock it directly
// so these tests pin the proxy's branch (require a session for any non-"open"
// decision); the decision table itself is covered in auth-gate.test.ts.
const enforcementMock = vi.fn();
vi.mock("@/lib/auth-gate", () => ({ resolveEnforcement: () => enforcementMock() }));
vi.mock("@/lib/auth-config-client", () => ({ getAuthConfig: vi.fn() }));

const { GET, POST } = await import("@/app/api/trpc/[trpc]/route");

const params = { params: Promise.resolve({ trpc: "curator.config" }) };

function proxyRequest(): NextRequest {
  return new NextRequest("http://localhost:3000/api/trpc/curator.config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

function proxyGetRequest(): NextRequest {
  return new NextRequest("http://localhost:3000/api/trpc/curator.config", { method: "GET" });
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  authMock.mockReset();
  enforcementMock.mockReset();
  enforcementMock.mockResolvedValue("enforce"); // default: auth on
  fetchSpy = vi.fn(async () => new Response('{"result":{"data":null}}', { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
  process.env.LIBRARIAN_ADMIN_TOKEN = "admin-token";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/api/trpc proxy session gate", () => {
  it("401s when auth is enforced and there is no session — without reaching upstream", async () => {
    authMock.mockResolvedValue(null);

    const res = await POST(proxyRequest(), params);

    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled(); // admin token never leaves the box
  });

  it("proxies through when auth is enforced and a session is present", async () => {
    authMock.mockResolvedValue({ user: { name: "owner" } });

    const res = await POST(proxyRequest(), params);

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const sent = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect((sent.headers as Headers).get("authorization")).toBe("Bearer admin-token");
  });

  it("gates GET (tRPC queries) too, not just POST", async () => {
    authMock.mockResolvedValue(null);

    const res = await GET(proxyGetRequest(), params);

    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed when auth() throws (e.g. a tampered token)", async () => {
    authMock.mockRejectedValue(new Error("bad jwt"));

    const res = await POST(proxyRequest(), params);

    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requires a session under the fail-closed 'block' decision too", async () => {
    enforcementMock.mockResolvedValue("block");
    authMock.mockResolvedValue(null);

    const res = await POST(proxyRequest(), params);

    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("proxies through when enforcement is open (backward compatible), never calling auth()", async () => {
    enforcementMock.mockResolvedValue("open");

    const res = await POST(proxyRequest(), params);

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(authMock).not.toHaveBeenCalled();
  });
});

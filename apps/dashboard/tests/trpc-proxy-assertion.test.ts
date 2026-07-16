import { readDashboardUser } from "@librarian/mcp-server/extension";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The server reader decodes what the proxy forwards — used here to assert the derived assertion.
import { DASHBOARD_USER_HEADER, DASHBOARD_USER_POISON } from "@/lib/dashboard-assertion";

// spec 065 SC 1 — the proxy ASSERTS, on every call, who it is on behalf of, derived from its OWN
// session (never the inbound header). These tests pin the four producer outcomes and the
// gate-before-derivation ordering.

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: () => authMock() }));

const enforcementMock = vi.fn();
vi.mock("@/lib/auth-gate", () => ({ resolveEnforcement: () => enforcementMock() }));
vi.mock("@/lib/auth-config-client", () => ({ getAuthConfig: vi.fn() }));

const { GET, POST } = await import("@/app/api/trpc/[trpc]/route");

const params = { params: Promise.resolve({ trpc: "memories.list" }) };

function request(opts: { cookie?: string; inboundAssertion?: string } = {}): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.inboundAssertion) headers[DASHBOARD_USER_HEADER] = opts.inboundAssertion;
  return new NextRequest("http://localhost:3000/api/trpc/memories.list", {
    method: "POST",
    headers,
    body: "{}",
  });
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  authMock.mockReset();
  enforcementMock.mockReset();
  enforcementMock.mockResolvedValue("open"); // default: derivation runs (no gate)
  fetchSpy = vi.fn(async () => new Response('{"result":{"data":null}}', { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The assertion the proxy forwarded upstream, decoded by the server reader. */
function forwardedAssertion() {
  const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
  const value = (init.headers as Headers).get(DASHBOARD_USER_HEADER);
  return readDashboardUser({ headers: { [DASHBOARD_USER_HEADER]: value ?? undefined } });
}

function forwardedRaw(): string | null {
  const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
  return (init.headers as Headers).get(DASHBOARD_USER_HEADER);
}

describe("/api/trpc proxy identity assertion (SC 1)", () => {
  it("a signed-in call carries the USER assertion, derived from the proxy's own session", async () => {
    authMock.mockResolvedValue({
      user: { sub: "42", provider: "github", email: "o@e.co", name: "Owner" },
    });

    const res = await POST(request({ cookie: "authjs.session-token=abc" }), params);

    expect(res.status).toBe(200);
    expect(forwardedAssertion()).toEqual({
      kind: "user",
      user: { provider: "github", sub: "42", email: "o@e.co", name: "Owner" },
    });
  });

  it("a signed-out call under enforcement 'open' carries the ANONYMOUS assertion (never absent)", async () => {
    const res = await POST(request(), params); // no session cookie

    expect(res.status).toBe(200);
    expect(forwardedAssertion()).toEqual({ kind: "anonymous" });
    // No session cookie ⇒ nothing to resolve ⇒ auth() is never called (open stays backward-compatible).
    expect(authMock).not.toHaveBeenCalled();
  });

  it("under non-open enforcement a sessionless call is 401'd by the gate BEFORE any header derivation", async () => {
    enforcementMock.mockResolvedValue("enforce");
    authMock.mockResolvedValue(null); // the gate's auth() resolves to no session

    const res = await POST(request({ cookie: "authjs.session-token=stale" }), params);

    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled(); // upstream never reached, no assertion derived
  });

  it("under 'open', a session cookie present but unresolvable carries the POISON marker", async () => {
    authMock.mockResolvedValue(null); // cookie present, session does not resolve (expired/tampered)

    const res = await POST(request({ cookie: "authjs.session-token=expired" }), params);

    expect(res.status).toBe(200);
    expect(forwardedRaw()).toBe(DASHBOARD_USER_POISON);
  });

  it("poisons a CHUNKED-then-expired session cookie too (prefix detection, SC 3 chunking fact)", async () => {
    authMock.mockResolvedValue(null);

    const res = await POST(
      request({ cookie: "authjs.session-token.0=part0; authjs.session-token.1=part1" }),
      params,
    );

    expect(res.status).toBe(200);
    expect(forwardedRaw()).toBe(DASHBOARD_USER_POISON);
  });

  it("poisons when auth() THROWS on a present cookie (tampered token), never a machine-trust absence", async () => {
    authMock.mockRejectedValue(new Error("bad jwt"));

    const res = await POST(request({ cookie: "authjs.session-token=tampered" }), params);

    expect(res.status).toBe(200);
    expect(forwardedRaw()).toBe(DASHBOARD_USER_POISON);
  });

  it("replaces a forged inbound identity header, never relays it", async () => {
    const forged = Buffer.from(JSON.stringify({ provider: "github", sub: "admin" })).toString(
      "base64url",
    );

    const res = await POST(request({ inboundAssertion: forged }), params); // no session cookie

    expect(res.status).toBe(200);
    expect(forwardedRaw()).not.toBe(forged);
    expect(forwardedAssertion()).toEqual({ kind: "anonymous" });
  });

  it("yields the POISON marker for an oversize claims set (never an oversize header)", async () => {
    authMock.mockResolvedValue({
      user: { sub: "42", provider: "github", name: "x".repeat(6000) },
    });

    const res = await POST(request({ cookie: "authjs.session-token=big" }), params);

    expect(res.status).toBe(200);
    expect(forwardedRaw()).toBe(DASHBOARD_USER_POISON);
  });

  it("derives the assertion on GET (tRPC queries) too", async () => {
    const getReq = new NextRequest("http://localhost:3000/api/trpc/memories.list", {
      method: "GET",
    });
    const res = await GET(getReq, params);

    expect(res.status).toBe(200);
    expect(forwardedAssertion()).toEqual({ kind: "anonymous" });
  });
});

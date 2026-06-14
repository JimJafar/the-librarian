import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// P2 (ADR 0008): the /api/trpc proxy forwards to the admin tRPC API, which now
// lives on its OWN internal listener. So the proxy must target LIBRARIAN_TRPC_URL
// (distinct from the agent LIBRARIAN_SERVER_URL), falling back to
// LIBRARIAN_SERVER_URL only for a single-server dev run.

vi.mock("@/auth", () => ({ auth: () => Promise.resolve({ user: { name: "owner" } }) }));
vi.mock("@/lib/auth-gate", () => ({ resolveEnforcement: () => Promise.resolve("open") }));
vi.mock("@/lib/auth-config-client", () => ({ getAuthConfig: vi.fn() }));

const { GET } = await import("@/app/api/trpc/[trpc]/route");

const params = { params: Promise.resolve({ trpc: "grooming.config" }) };

function proxyGetRequest(): NextRequest {
  return new NextRequest("http://localhost:3000/api/trpc/grooming.config", { method: "GET" });
}

const PRIOR = {
  trpc: process.env.LIBRARIAN_TRPC_URL,
  server: process.env.LIBRARIAN_SERVER_URL,
};

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  delete process.env.LIBRARIAN_TRPC_URL;
  delete process.env.LIBRARIAN_SERVER_URL;
  fetchSpy = vi.fn(async () => new Response('{"result":{"data":null}}', { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (PRIOR.trpc === undefined) delete process.env.LIBRARIAN_TRPC_URL;
  else process.env.LIBRARIAN_TRPC_URL = PRIOR.trpc;
  if (PRIOR.server === undefined) delete process.env.LIBRARIAN_SERVER_URL;
  else process.env.LIBRARIAN_SERVER_URL = PRIOR.server;
});

function upstreamUrl(): string {
  const arg = fetchSpy.mock.calls[0]?.[0];
  return arg instanceof URL ? arg.toString() : String(arg);
}

describe("/api/trpc proxy upstream target", () => {
  it("forwards to LIBRARIAN_TRPC_URL when set", async () => {
    process.env.LIBRARIAN_TRPC_URL = "http://mcp-server:3840";
    process.env.LIBRARIAN_SERVER_URL = "http://mcp-server:3838";

    await GET(proxyGetRequest(), params);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(upstreamUrl()).toBe("http://mcp-server:3840/trpc/grooming.config");
  });

  it("falls back to LIBRARIAN_SERVER_URL when LIBRARIAN_TRPC_URL is unset (dev)", async () => {
    process.env.LIBRARIAN_SERVER_URL = "http://127.0.0.1:3838";

    await GET(proxyGetRequest(), params);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(upstreamUrl()).toBe("http://127.0.0.1:3838/trpc/grooming.config");
  });
});

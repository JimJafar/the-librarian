import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAgentAuthProbeCacheForTests, proxyAgentRequest } from "@/lib/agent-proxy";

const PRIOR_FLAG = process.env.LIBRARIAN_SINGLE_PORT;
let fetchSpy: ReturnType<typeof vi.fn>;

function request(path = "/mcp"): NextRequest {
  return new NextRequest(`https://library.example${path}`, {
    method: "POST",
    headers: {
      authorization: "Bearer agent-token",
      "content-type": "application/json",
    },
    body: "{}",
  });
}

function health(status: "enabled" | "disabled" | "unknown"): Response {
  return Response.json({ status: "ok", mcp_auth: status });
}

beforeEach(() => {
  process.env.LIBRARIAN_SINGLE_PORT = "true";
  clearAgentAuthProbeCacheForTests();
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (PRIOR_FLAG === undefined) delete process.env.LIBRARIAN_SINGLE_PORT;
  else process.env.LIBRARIAN_SINGLE_PORT = PRIOR_FLAG;
});

describe("single-port protected-route guard", () => {
  it("refuses when the active upstream provider admits anonymous agent traffic", async () => {
    fetchSpy.mockResolvedValueOnce(health("disabled"));

    const response = await proxyAgentRequest(request(), "/mcp");

    expect(response.status).toBe(503);
    expect(await response.text()).toContain("LIBRARIAN_AGENT_TOKEN");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("/healthz?auth_probe=1");
    expect((fetchSpy.mock.calls[0]?.[1] as RequestInit).cache).toBe("no-store");
  });

  it("maps an unreachable or indeterminate auth probe to 502 and negative-caches it", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("offline"));

    expect((await proxyAgentRequest(request(), "/mcp")).status).toBe(502);
    expect((await proxyAgentRequest(request(), "/mcp")).status).toBe(502);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("never positive-caches enabled, and marks each forwarded request as auth-required", async () => {
    fetchSpy
      .mockResolvedValueOnce(health("enabled"))
      .mockResolvedValueOnce(new Response("first"))
      .mockResolvedValueOnce(health("enabled"))
      .mockResolvedValueOnce(new Response("second"));

    expect(await (await proxyAgentRequest(request(), "/mcp")).text()).toBe("first");
    expect(await (await proxyAgentRequest(request(), "/mcp")).text()).toBe("second");

    expect(fetchSpy).toHaveBeenCalledTimes(4);
    for (const index of [1, 3]) {
      const init = fetchSpy.mock.calls[index]?.[1] as RequestInit;
      expect((init.headers as Headers).get("x-librarian-require-auth")).toBe("single-port");
    }
  });

  it("expires a disabled result after 60 seconds", async () => {
    vi.useFakeTimers();
    fetchSpy
      .mockResolvedValueOnce(health("disabled"))
      .mockResolvedValueOnce(health("enabled"))
      .mockResolvedValueOnce(new Response("ok"));

    expect((await proxyAgentRequest(request(), "/mcp")).status).toBe(503);
    await vi.advanceTimersByTimeAsync(60_001);
    expect((await proxyAgentRequest(request(), "/mcp")).status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});

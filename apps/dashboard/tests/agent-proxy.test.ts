import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proxyAgentRequest } from "@/lib/agent-proxy";

const PRIOR = {
  singlePort: process.env.LIBRARIAN_SINGLE_PORT,
  serverUrl: process.env.LIBRARIAN_SERVER_URL,
};

let fetchSpy: ReturnType<typeof vi.fn>;

function request(
  path = "/healthz",
  init: NonNullable<ConstructorParameters<typeof NextRequest>[1]> = {},
): NextRequest {
  return new NextRequest(`https://library.example${path}?probe=1`, init);
}

beforeEach(() => {
  delete process.env.LIBRARIAN_SINGLE_PORT;
  delete process.env.LIBRARIAN_SERVER_URL;
  fetchSpy = vi.fn(async () => {
    return new Response("upstream", {
      status: 201,
      headers: {
        "content-type": "text/plain",
        "content-encoding": "gzip",
        "transfer-encoding": "chunked",
        "x-upstream": "yes",
      },
    });
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (PRIOR.singlePort === undefined) delete process.env.LIBRARIAN_SINGLE_PORT;
  else process.env.LIBRARIAN_SINGLE_PORT = PRIOR.singlePort;
  if (PRIOR.serverUrl === undefined) delete process.env.LIBRARIAN_SERVER_URL;
  else process.env.LIBRARIAN_SERVER_URL = PRIOR.serverUrl;
});

describe("single-port agent proxy", () => {
  it("is inert unless LIBRARIAN_SINGLE_PORT is exactly true", async () => {
    process.env.LIBRARIAN_SINGLE_PORT = "TRUE";

    const response = await proxyAgentRequest(request(), "/healthz");

    expect(response.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("streams the upstream response through the configured agent listener", async () => {
    process.env.LIBRARIAN_SINGLE_PORT = "true";
    process.env.LIBRARIAN_SERVER_URL = "http://mcp-server:3838";

    const response = await proxyAgentRequest(request(), "/healthz");

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("http://mcp-server:3838/healthz?probe=1");
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("upstream");
    expect(response.headers.get("x-upstream")).toBe("yes");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("transfer-encoding")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("forwards bearer and forensic headers but strips browser session material", async () => {
    process.env.LIBRARIAN_SINGLE_PORT = "true";
    const response = await proxyAgentRequest(
      request("/healthz", {
        method: "POST",
        headers: {
          authorization: "Bearer agent-token",
          cookie: "session=private",
          connection: "keep-alive, x-connection-private",
          host: "attacker.example",
          "content-length": "2",
          expect: "100-continue",
          "keep-alive": "timeout=5",
          "proxy-authorization": "Basic private",
          te: "trailers",
          trailer: "x-checksum",
          "transfer-encoding": "chunked",
          upgrade: "websocket",
          "x-connection-private": "must-not-forward",
          "x-forwarded-for": "198.51.100.8, 10.0.0.1",
          "x-librarian-dashboard-user": "forged",
          "content-type": "application/json",
        },
        body: "{}",
      }),
      "/healthz",
    );

    expect(response.status).toBe(201);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer agent-token");
    expect(headers.get("x-forwarded-for")).toBe("198.51.100.8, 10.0.0.1");
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("x-librarian-dashboard-user")).toBeNull();
    expect(headers.get("host")).toBeNull();
    expect(headers.get("connection")).toBeNull();
    expect(headers.get("content-length")).toBeNull();
    expect(headers.get("expect")).toBeNull();
    expect(headers.get("keep-alive")).toBeNull();
    expect(headers.get("proxy-authorization")).toBeNull();
    expect(headers.get("te")).toBeNull();
    expect(headers.get("trailer")).toBeNull();
    expect(headers.get("transfer-encoding")).toBeNull();
    expect(headers.get("upgrade")).toBeNull();
    expect(headers.get("x-connection-private")).toBeNull();
    expect(init.redirect).toBe("error");
    expect(init.cache).toBe("no-store");
    expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(new Uint8Array([123, 125]));
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects an oversized body before reading or forwarding it", async () => {
    process.env.LIBRARIAN_SINGLE_PORT = "true";
    fetchSpy.mockResolvedValueOnce(Response.json({ mcp_auth: "enabled" }));

    const response = await proxyAgentRequest(
      request("/ingest", {
        method: "POST",
        headers: { "content-length": String(2 * 1024 * 1024 + 1) },
        body: "{}",
      }),
      "/ingest",
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "Request body too large: the /ingest proxy cap is 2 MB",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("/healthz?auth_probe=1");
  });
});

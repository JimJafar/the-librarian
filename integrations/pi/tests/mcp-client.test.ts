import { afterEach, describe, expect, it } from "vitest";
import { createMcpClient, McpClientError } from "../extensions/librarian/mcp-client.js";
import { mcpTextEnvelope, startFakeServer, type FakeServer } from "./helpers/fake-server.js";

// The token is assembled at runtime so no secret-shaped literal lands in
// committed source (AGENTS.md §2, GitGuardian note).
const TOKEN = ["test", "bearer", "value"].join("-");

let server: FakeServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("createMcpClient (against a real local HTTP server)", () => {
  it("POSTs a tools/call envelope with the bearer token and returns the text", async () => {
    server = await startFakeServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(mcpTextEnvelope("Found 2 memories…"));
    });
    const client = createMcpClient({ endpoint: `${server.url}/mcp`, token: TOKEN });

    const text = await client.callTool("recall", { query: "auth" });

    expect(text).toBe("Found 2 memories…");
    const request = server.requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/mcp");
    expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(request.body)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "recall", arguments: { query: "auth" } },
    });
  });

  it("maps a non-200 onto an http error without leaking the token", async () => {
    server = await startFakeServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
    });
    const client = createMcpClient({ endpoint: `${server.url}/mcp`, token: TOKEN });

    const error = await client.callTool("recall", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpClientError);
    expect((error as McpClientError).kind).toBe("http");
    expect((error as McpClientError).status).toBe(401);
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it("maps a JSON-RPC error payload onto an rpc error (truncated message)", async () => {
    server = await startFakeServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32602, message: "x".repeat(500) },
        }),
      );
    });
    const client = createMcpClient({ endpoint: `${server.url}/mcp`, token: TOKEN });

    const error = await client.callTool("remember", {}).catch((e: unknown) => e);
    expect((error as McpClientError).kind).toBe("rpc");
    // Server-controlled message is truncated so it can't bloat logs.
    expect((error as Error).message.length).toBeLessThan(300);
  });

  it("refuses to follow a 3xx (a redirect would carry the bearer token)", async () => {
    server = await startFakeServer((_req, res) => {
      res.writeHead(302, { location: "https://evil.example/steal" });
      res.end();
    });
    const client = createMcpClient({ endpoint: `${server.url}/mcp`, token: TOKEN });

    const error = await client.callTool("recall", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpClientError);
    expect((error as McpClientError).kind).toBe("network");
    expect((error as Error).message).not.toContain(TOKEN);
    expect((error as Error).message).not.toContain("evil.example");
    // Exactly one request reached the fake server; nothing was followed.
    expect(server.requests).toHaveLength(1);
  });

  it("rejects a response larger than the size cap", async () => {
    server = await startFakeServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(mcpTextEnvelope("y".repeat(4096)));
    });
    const client = createMcpClient({
      endpoint: `${server.url}/mcp`,
      token: TOKEN,
      maxResponseBytes: 1024,
    });

    const error = await client.callTool("recall", {}).catch((e: unknown) => e);
    expect((error as McpClientError).kind).toBe("malformed");
    expect((error as Error).message).toContain("size cap");
  });

  it("maps non-JSON onto a malformed error", async () => {
    server = await startFakeServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>gateway error</html>");
    });
    const client = createMcpClient({ endpoint: `${server.url}/mcp`, token: TOKEN });

    const error = await client.callTool("recall", {}).catch((e: unknown) => e);
    expect((error as McpClientError).kind).toBe("malformed");
  });

  it("times out a hung server with a timeout error", async () => {
    server = await startFakeServer(() => {
      // Never respond — the client's AbortController must fire.
    });
    const client = createMcpClient({
      endpoint: `${server.url}/mcp`,
      token: TOKEN,
      timeoutMs: 100,
    });

    const error = await client.callTool("recall", {}).catch((e: unknown) => e);
    expect((error as McpClientError).kind).toBe("timeout");
  });

  it("maps an unreachable server onto a network error naming only the safe endpoint", async () => {
    const probe = await startFakeServer((_req, res) => res.end());
    const url = `${probe.url}/mcp`;
    await probe.close(); // port is now closed

    const client = createMcpClient({ endpoint: `${url}?secret=q`, token: TOKEN });
    const error = await client.callTool("recall", {}).catch((e: unknown) => e);
    expect((error as McpClientError).kind).toBe("network");
    expect((error as Error).message).not.toContain(TOKEN);
    // The query string is stripped from the rendered endpoint.
    expect((error as Error).message).not.toContain("secret=q");
  });
});

describe("createMcpClient (credential validation)", () => {
  it("rejects a non-http(s) endpoint scheme", () => {
    expect(() => createMcpClient({ endpoint: "file:///etc/passwd", token: TOKEN })).toThrow(
      McpClientError,
    );
  });

  it("rejects an endpoint with embedded basic-auth credentials", () => {
    expect(() =>
      createMcpClient({ endpoint: "https://user:pw@librarian.example/mcp", token: TOKEN }),
    ).toThrow(/must not embed credentials/);
  });

  it("rejects an unparseable endpoint", () => {
    expect(() => createMcpClient({ endpoint: "not a url", token: TOKEN })).toThrow(
      /not a valid URL/,
    );
  });
});

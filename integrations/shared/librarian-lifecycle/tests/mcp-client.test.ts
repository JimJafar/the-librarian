import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  formatSessionLifecycle,
  formatSessionList,
  formatSessionStart,
} from "@librarian/mcp-server/formatters";
import { afterEach, describe, expect, it } from "vitest";
import {
  type McpTransport,
  McpClientError,
  createMcpClient,
  parseSessionFromProse,
  parseSessionListFromProse,
} from "../src/mcp-client.js";

const ENDPOINT = "https://librarian.example/mcp";
const TOKEN = "tok_super_secret_value";

function rpcResult(text: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } });
}

function transportReturning(
  status: number,
  body: string,
): { transport: McpTransport; reqs: Parameters<McpTransport>[0][] } {
  const reqs: Parameters<McpTransport>[0][] = [];
  const transport: McpTransport = async (req) => {
    reqs.push(req);
    return { status, body };
  };
  return { transport, reqs };
}

// A bare Session shape — the formatters only read these fields, so a cast keeps
// the test independent of @librarian/core's full Session type.
function session(overrides: Record<string, unknown> = {}): never {
  return {
    id: "ses_round_trip",
    status: "active",
    title: "Round trip",
    visibility: "common",
    project_key: "the-librarian",
    current_harness: "claude-code",
    start_summary: "do the work",
    last_activity_at: "2026-05-24T10:00:00.000Z",
    next_steps: [],
    tags: [],
    ...overrides,
  } as never;
}

describe("createMcpClient — request envelope", () => {
  it("POSTs a tools/call envelope with a bearer token and returns the text content", async () => {
    const { transport, reqs } = transportReturning(200, rpcResult("recalled"));
    const client = createMcpClient({ endpoint: ENDPOINT, token: TOKEN }, transport);

    const text = await client.callTool("recall", { query: "x" });

    expect(text).toBe("recalled");
    const req = reqs[0]!;
    expect(req.url).toBe(ENDPOINT);
    expect(req.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.headers["Content-Type"]).toBe("application/json");
    const parsed = JSON.parse(req.body);
    expect(parsed.method).toBe("tools/call");
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.params).toEqual({ name: "recall", arguments: { query: "x" } });
  });
});

describe("createMcpClient — error mapping", () => {
  it("maps a non-200 status to a typed http error carrying the status", async () => {
    const { transport } = transportReturning(503, "upstream down");
    const client = createMcpClient({ endpoint: ENDPOINT, token: TOKEN }, transport);
    await expect(client.callTool("recall", {})).rejects.toMatchObject({
      name: "McpClientError",
      kind: "http",
      status: 503,
    });
  });

  it("maps a JSON-RPC error payload to a typed rpc error with the (truncated) message", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "boom" },
    });
    const { transport } = transportReturning(200, body);
    const client = createMcpClient({ endpoint: ENDPOINT, token: TOKEN }, transport);
    const err = await client.callTool("recall", {}).catch((e) => e);
    expect(err).toBeInstanceOf(McpClientError);
    expect(err.kind).toBe("rpc");
    expect(err.message).toContain("boom");
  });

  it("maps non-JSON to a malformed error", async () => {
    const { transport } = transportReturning(200, "<html>not json</html>");
    const client = createMcpClient({ endpoint: ENDPOINT, token: TOKEN }, transport);
    await expect(client.callTool("recall", {})).rejects.toMatchObject({ kind: "malformed" });
  });

  it("maps a result with no text content to a malformed error", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } });
    const { transport } = transportReturning(200, body);
    const client = createMcpClient({ endpoint: ENDPOINT, token: TOKEN }, transport);
    await expect(client.callTool("recall", {})).rejects.toMatchObject({ kind: "malformed" });
  });

  it("maps a transport TimeoutError to a typed timeout error", async () => {
    const transport: McpTransport = async () => {
      throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    };
    const client = createMcpClient({ endpoint: ENDPOINT, token: TOKEN }, transport);
    await expect(client.callTool("recall", {})).rejects.toMatchObject({ kind: "timeout" });
  });

  it("maps an arbitrary transport failure to a typed network error", async () => {
    const transport: McpTransport = async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:3838");
    };
    const client = createMcpClient({ endpoint: ENDPOINT, token: TOKEN }, transport);
    await expect(client.callTool("recall", {})).rejects.toMatchObject({ kind: "network" });
  });

  it("treats a spec-tolerant `error: null` alongside a result as success", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: null,
      result: { content: [{ type: "text", text: "ok" }] },
    });
    const { transport } = transportReturning(200, body);
    const client = createMcpClient({ endpoint: ENDPOINT, token: TOKEN }, transport);
    await expect(client.callTool("recall", {})).resolves.toBe("ok");
  });

  it("never leaks the token in any error message", async () => {
    const cases: McpTransport[] = [
      async () => ({ status: 500, body: TOKEN }), // even if the server echoes it
      async () => ({ status: 200, body: "not json" }),
      async () => {
        throw new Error(`failed talking to host with ${TOKEN}`);
      },
    ];
    for (const transport of cases) {
      const client = createMcpClient({ endpoint: ENDPOINT, token: TOKEN }, transport);
      const err = await client.callTool("recall", {}).catch((e: Error) => e);
      expect(err).toBeInstanceOf(McpClientError);
      expect(err.message).not.toContain(TOKEN);
    }
  });
});

describe("createMcpClient — scheme allowlist", () => {
  it("rejects a non-http(s) endpoint scheme at construction", () => {
    expect(() => createMcpClient({ endpoint: "file:///etc/passwd", token: TOKEN })).toThrow(
      McpClientError,
    );
    expect(() => createMcpClient({ endpoint: "ftp://host/x", token: TOKEN })).toThrow(
      McpClientError,
    );
  });

  it("accepts http and https endpoints", () => {
    expect(() =>
      createMcpClient({ endpoint: "http://127.0.0.1:3838/mcp", token: TOKEN }),
    ).not.toThrow();
    expect(() =>
      createMcpClient({ endpoint: "https://lib.example/mcp", token: TOKEN }),
    ).not.toThrow();
  });

  it("rejects an endpoint that embeds basic-auth credentials (a second secret)", () => {
    const err = (() => {
      try {
        createMcpClient({ endpoint: "https://user:s3cr3t@lib.example/mcp", token: TOKEN });
        return null;
      } catch (e) {
        return e as McpClientError;
      }
    })();
    expect(err).toBeInstanceOf(McpClientError);
    expect(err?.kind).toBe("config");
    expect(err?.message).not.toContain("s3cr3t");
  });
});

describe("parseSessionFromProse — round-trips the real formatters", () => {
  it("parses a start-session block", () => {
    const parsed = parseSessionFromProse(formatSessionStart(session()));
    expect(parsed).toMatchObject({
      id: "ses_round_trip",
      status: "active",
      title: "Round trip",
      project_key: "the-librarian",
    });
  });

  it("parses a lifecycle (checkpoint/pause/end) block", () => {
    const text = formatSessionLifecycle(session({ status: "paused" }), "Session paused.");
    expect(parseSessionFromProse(text)).toMatchObject({ id: "ses_round_trip", status: "paused" });
  });

  it("treats a (none) project as null", () => {
    const parsed = parseSessionFromProse(formatSessionStart(session({ project_key: null })));
    expect(parsed?.project_key).toBeNull();
  });

  it("returns null for prose with no session id", () => {
    expect(parseSessionFromProse("No session found for id ses_x.")).toBeNull();
  });
});

describe("parseSessionListFromProse — round-trips the real formatter", () => {
  it("parses every entry's id and status in order", () => {
    const list = {
      total: 2,
      sessions: [
        session({ id: "ses_a", status: "paused", title: "A", next_steps: ["next a"] }),
        session({
          id: "ses_b",
          status: "active",
          title: "B",
          project_key: null,
          current_harness: null,
        }),
      ],
    } as never;
    const parsed = parseSessionListFromProse(formatSessionList(list));
    expect(parsed.map((s) => s.id)).toEqual(["ses_a", "ses_b"]);
    expect(parsed.map((s) => s.status)).toEqual(["paused", "active"]);
  });

  it("preserves a title that itself contains the ' — ' separator", () => {
    const list = {
      total: 1,
      sessions: [session({ id: "ses_dash", status: "active", title: "Fix bug — urgent" })],
    } as never;
    const parsed = parseSessionListFromProse(formatSessionList(list));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      id: "ses_dash",
      status: "active",
      title: "Fix bug — urgent",
      project_key: "the-librarian",
    });
  });

  it("returns [] for an empty list", () => {
    const parsed = parseSessionListFromProse(
      formatSessionList({ total: 0, sessions: [] } as never),
    );
    expect(parsed).toEqual([]);
  });
});

// --- Default transport: real-server security behaviour (the bearer-leak class
// of bug from the Hermes client review). These exercise the built-in fetch
// transport rather than an injected one. ---

describe("default transport — security", () => {
  const servers: http.Server[] = [];

  function listen(server: http.Server): Promise<number> {
    servers.push(server);
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });
  }

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    );
  });

  it("sends the bearer token and returns the text on the happy path", async () => {
    let authSeen: string | undefined;
    const port = await listen(
      http.createServer((req, res) => {
        authSeen = req.headers.authorization;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(rpcResult("live"));
      }),
    );
    const client = createMcpClient({ endpoint: `http://127.0.0.1:${port}/mcp`, token: TOKEN });
    await expect(client.callTool("recall", {})).resolves.toBe("live");
    expect(authSeen).toBe(`Bearer ${TOKEN}`);
  });

  it("refuses to follow a 3xx redirect (no cross-origin token leak)", async () => {
    const targetHits: (string | undefined)[] = [];
    const targetPort = await listen(
      http.createServer((req, res) => {
        targetHits.push(req.headers.authorization);
        res.end(rpcResult("leaked"));
      }),
    );
    const redirectorPort = await listen(
      http.createServer((_req, res) => {
        res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/mcp` });
        res.end();
      }),
    );
    const client = createMcpClient({
      endpoint: `http://127.0.0.1:${redirectorPort}/mcp`,
      token: TOKEN,
    });
    await expect(client.callTool("recall", {})).rejects.toBeInstanceOf(McpClientError);
    expect(targetHits).toEqual([]); // the redirect target was never contacted
  });

  it("caps the response body so a runaway endpoint cannot exhaust memory", async () => {
    const port = await listen(
      http.createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("x".repeat(2048));
      }),
    );
    const client = createMcpClient({
      endpoint: `http://127.0.0.1:${port}/mcp`,
      token: TOKEN,
      maxResponseBytes: 256,
    });
    await expect(client.callTool("recall", {})).rejects.toBeInstanceOf(McpClientError);
  });

  it("times out a slow endpoint", async () => {
    const port = await listen(
      http.createServer(() => {
        /* never responds */
      }),
    );
    const client = createMcpClient({
      endpoint: `http://127.0.0.1:${port}/mcp`,
      token: TOKEN,
      timeoutMs: 120,
    });
    await expect(client.callTool("recall", {})).rejects.toMatchObject({ kind: "timeout" });
  });
});

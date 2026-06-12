// Minimal MCP client for the Librarian HTTP server.
//
// The Librarian's `/mcp` is a STATELESS JSON-RPC 2.0 endpoint: no `initialize`
// handshake and no session id — a `tools/call` is POSTed directly with a Bearer
// token. So this is a single-request client: build the envelope, POST it, map
// every failure onto a typed `McpClientError`, and return the tool's text.
//
// Ported from the standalone the-librarian-pi-extension repo (2026-06-12
// rethink, D14) minus the retired session-prose parsers. Mirrors the security
// posture of the Hermes integration's `client.py` (which a security review
// hardened): the bearer token lives ONLY in the Authorization header and is
// never put into an error message; 3xx redirects are refused so a redirect
// can't carry the token cross-origin; the endpoint scheme is allowlisted to
// http(s); and the response body is capped so a runaway endpoint cannot
// exhaust memory. The transport is injectable so tests never touch the
// network.

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_RPC_MESSAGE_CHARS = 200;

export type McpClientErrorKind = "config" | "network" | "timeout" | "http" | "rpc" | "malformed";

export class McpClientError extends Error {
  override readonly name = "McpClientError";
  readonly kind: McpClientErrorKind;
  readonly status?: number | undefined;

  constructor(kind: McpClientErrorKind, message: string, extra: { status?: number } = {}) {
    super(message);
    this.kind = kind;
    this.status = extra.status;
  }
}

export interface McpRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

export interface McpResponse {
  status: number;
  body: string;
}

/** POST and return `(status, body)`. Throw a TimeoutError-named error on timeout. */
export type McpTransport = (req: McpRequest) => Promise<McpResponse>;

export interface McpClientConfig {
  endpoint: string;
  token: string;
  timeoutMs?: number;
  /** Cap on the buffered response body (default 8 MiB). */
  maxResponseBytes?: number;
}

export interface McpClient {
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
}

export function createMcpClient(config: McpClientConfig, transport?: McpTransport): McpClient {
  let url: URL;
  try {
    url = new URL(config.endpoint);
  } catch {
    throw new McpClientError("config", "Librarian endpoint is not a valid URL");
  }
  // Allowlist the scheme so a mistemplated endpoint can't reach a file:/data:
  // handler (config-driven SSRF / local file read).
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new McpClientError(
      "config",
      `Librarian endpoint must be http(s), got ${url.protocol.replace(/:$/, "") || "(none)"}`,
    );
  }
  // Reject HTTP basic-auth userinfo in the URL: the token is the auth mechanism,
  // and an embedded password is a second secret that would otherwise leak into
  // the network error message below (same leak class as the bearer token).
  if (url.username || url.password) {
    throw new McpClientError(
      "config",
      "Librarian endpoint must not embed credentials; authenticate with the token instead",
    );
  }
  const endpoint = config.endpoint;
  // A credential-free, query-free rendering used in error messages so nothing
  // secret-bearing in the endpoint can leak into logs.
  const safeEndpoint = `${url.protocol}//${url.host}${url.pathname}`;
  const token = config.token;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const send = transport ?? defaultTransport(maxResponseBytes);

  return {
    async callTool(name, args) {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      });
      // The token lives ONLY here — never in args, the URL, or any error text.
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      };

      let response: McpResponse;
      try {
        response = await send({ url: endpoint, body, headers, timeoutMs });
      } catch (err) {
        if (err instanceof McpClientError) throw err;
        if (isTimeoutError(err)) {
          throw new McpClientError("timeout", `${name} timed out after ${timeoutMs}ms`);
        }
        // Don't interpolate the underlying error (it may echo the request) —
        // keep the token-bearing call strictly out of anything we render.
        throw new McpClientError(
          "network",
          `${name} could not reach the Librarian at ${safeEndpoint}`,
        );
      }

      if (response.status !== 200) {
        throw new McpClientError("http", `${name} returned HTTP ${response.status}`, {
          status: response.status,
        });
      }

      let payload: unknown;
      try {
        payload = JSON.parse(response.body);
      } catch {
        throw new McpClientError("malformed", `${name} returned non-JSON`);
      }

      // `!= null` (not `"error" in payload`) so a spec-tolerant `error: null`
      // alongside a result is treated as success, not a phantom rpc failure.
      if (isRecord(payload) && payload.error != null) {
        const rpc = payload.error;
        const code = isRecord(rpc) ? rpc.code : undefined;
        // Truncate the server-controlled message so it can't bloat logs.
        const msg = isRecord(rpc) ? String(rpc.message ?? "").slice(0, MAX_RPC_MESSAGE_CHARS) : "";
        throw new McpClientError("rpc", `${name} failed: ${msg} (code ${String(code)})`);
      }

      const text = extractText(payload);
      if (text === null) {
        throw new McpClientError("malformed", `${name} response had no text content`);
      }
      return text;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTimeoutError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  const code = (err as { code?: string } | null)?.code;
  return name === "AbortError" || name === "TimeoutError" || code === "ETIMEDOUT";
}

/** Pull `result.content[0].text` from an MCP tool response, or null. */
function extractText(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const result = payload.result;
  if (!isRecord(result)) return null;
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const first: unknown = content[0];
  if (!isRecord(first)) return null;
  return typeof first.text === "string" ? first.text : null;
}

function defaultTransport(maxResponseBytes: number): McpTransport {
  return async ({ url, body, headers, timeoutMs }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        body,
        headers,
        // A 3xx must NEVER be followed: fetch would carry the Authorization
        // header to the redirect target and leak the bearer token cross-origin.
        // The Librarian /mcp is a single stateless POST with no legitimate 3xx.
        redirect: "error",
        signal: controller.signal,
      });
      return { status: response.status, body: await readCapped(response, maxResponseBytes) };
    } finally {
      clearTimeout(timer);
    }
  };
}

async function readCapped(response: Response, cap: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    // No readable stream (e.g. an empty body). arrayBuffer buffers fully, but
    // we still enforce the BYTE cap before decoding so the protection holds.
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > cap) {
      throw new McpClientError("malformed", "Librarian response exceeded the size cap");
    }
    return buffer.toString("utf8");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new McpClientError("malformed", "Librarian response exceeded the size cap");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

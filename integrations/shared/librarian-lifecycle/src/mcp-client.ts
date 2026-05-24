// Minimal MCP client for the Librarian HTTP server (remote lifecycle transport).
//
// The Librarian's `/mcp` is a STATELESS JSON-RPC 2.0 endpoint: no `initialize`
// handshake and no session id — a `tools/call` is POSTed directly with a Bearer
// token. So this is a single-request client: build the envelope, POST it, map
// every failure onto a typed `McpClientError`, and return the tool's text.
//
// Mirrors the security posture of the Hermes plugin's `client.py` (which a
// security review hardened): the bearer token lives ONLY in the Authorization
// header and is never put into an error message; 3xx redirects are refused so a
// redirect can't carry the token cross-origin; the endpoint scheme is
// allowlisted to http(s); and the response body is capped so a runaway endpoint
// cannot exhaust memory. The transport is injectable so tests never touch the
// network.
//
// MCP session tools return human-readable PROSE (see `@librarian/mcp-server`
// formatters), not JSON, so this module also parses the two shapes the lifecycle
// needs (a single session block, and a session list). The parsers are pinned to
// the real formatters by round-trip tests in the same monorepo.

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

// --- Prose parsers (pinned to @librarian/mcp-server formatters by round-trip
// tests). The lifecycle only needs `id` + `status`; other fields are best-effort.

export interface ParsedSession {
  id: string;
  status: string;
  title: string | null;
  project_key: string | null;
  source_ref: string | null;
  cwd: string | null;
}

function firstMatch(text: string, re: RegExp): string | null {
  const m = text.match(re);
  return m?.[1] ? m[1].trim() : null;
}

function projectOrNull(value: string | null): string | null {
  return value === null || value === "(none)" || value === "no project" ? null : value;
}

/**
 * Parse a single-session block (`formatSessionStart` / `formatSessionLifecycle`
 * / `formatSessionDetail`). Returns null when there is no `ID:`/`Status:` pair.
 */
export function parseSessionFromProse(text: string): ParsedSession | null {
  const id = firstMatch(text, /^ID:\s*(.+)$/m);
  const status = firstMatch(text, /^Status:\s*(.+)$/m);
  if (!id || !status) return null;
  const title = firstMatch(text, /^Title:\s*(.+)$/m) ?? firstMatch(text, /^Session:\s*(.+)$/m);
  return {
    id,
    status,
    title,
    project_key: projectOrNull(firstMatch(text, /^Project:\s*(.+)$/m)),
    source_ref: firstMatch(text, /^Source:\s*(.+)$/m),
    cwd: firstMatch(text, /^Cwd:\s*(.+)$/m),
  };
}

/**
 * Parse a session list (`formatSessionList`). Each entry is a numbered headline
 * `N. [status] title — project — harness — last: …` followed (possibly after a
 * `next:` line) by an `id: …` line.
 */
export function parseSessionListFromProse(text: string): ParsedSession[] {
  const sessions: ParsedSession[] = [];
  let status: string | null = null;
  let title: string | null = null;
  let project: string | null = null;
  for (const line of text.split("\n")) {
    const head = line.match(/^\d+\.\s*\[([^\]]+)\]\s*(.*)$/);
    if (head) {
      status = head[1]!.trim();
      // The headline tail is `title — project — harness — last: <ts>`. project,
      // harness, and last never contain the " — " separator, but a TITLE can, so
      // parse from the RIGHT: the last three segments are fixed, the rest is the
      // title. (title/project are best-effort; only id+status are load-bearing.)
      const segments = (head[2] ?? "").split(" — ");
      if (segments.length >= 4) {
        project = projectOrNull(segments[segments.length - 3]!.trim());
        title =
          segments
            .slice(0, segments.length - 3)
            .join(" — ")
            .trim() || null;
      } else {
        title = segments[0]?.trim() || null;
        project = projectOrNull(segments[1]?.trim() ?? null);
      }
      continue;
    }
    const idLine = line.match(/^\s*id:\s*(\S+)/);
    if (idLine && status) {
      sessions.push({
        id: idLine[1]!,
        status,
        title,
        project_key: project,
        source_ref: null,
        cwd: null,
      });
      status = null;
      title = null;
      project = null;
    }
  }
  return sessions;
}

// HTTP request dispatcher.
//
// Pure routing layer over the LibrarianStore — no env, no boot-time
// validation. `createRouteHandler(deps)` returns the handler function
// the `node:http` server calls per request.
//
// Two surfaces (ADR 0008 P1 — split the listener; spec §4 "Two listeners"):
//
//   - "public"  — the published port (LIBRARIAN_HOST:PORT). Serves the
//     agent-facing surface: `/healthz`, `/primer.md`, `/mcp`. A request to
//     `/trpc/*` here 404s: the admin tRPC API (which `auth.config` uses to
//     return DECRYPTED secrets) is deliberately NOT exposed on the network.
//   - "internal" — a loopback/docker-network port (LIBRARIAN_TRPC_HOST:PORT,
//     unpublished). Serves ONLY `/trpc/*`. `/mcp`, `/healthz`, `/primer.md`
//     are not its job and 404.
//
// ADR 0008 P3: the `/trpc` surface is TRUSTED by isolation — the internal
// listener grants the admin role with NO bearer (the context factory resolves
// the "internal" surface to admin). The admin token is no longer a network gate;
// the socket itself is the boundary.
//
// The legacy dashboard file serves (`/`, `/styles.css`, `/app.js`) and `/api/*`
// REST routes are retired — the new Next.js dashboard at apps/dashboard
// is the canonical admin surface and uses Server Actions + browser
// tRPC. Anything else 404s.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type IngestVia,
  type LibrarianStore,
  checkIngestRateLimit,
  isIntakeEnabled,
  readPrimer,
  recordPending,
} from "@librarian/core";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { handleMcpPayload } from "../mcp/rpc.js";
import { createContextFactory } from "../trpc/context.js";
import { appRouter } from "../trpc/router.js";
import { type AuthConfig, authenticatePublic, isAllowedOrigin } from "./auth.js";
import { handleTranscriptIntake } from "./transcript-intake.js";

/** Which listener this handler serves (ADR 0008 P1, spec §4). */
export type RouteSurface = "public" | "internal";

export interface RouteDeps {
  store: LibrarianStore;
  auth: AuthConfig;
  maxBodyBytes: number;
  secretKey: Buffer | null;
  /**
   * The listener this handler serves. "public" serves the agent surface
   * (/mcp, /healthz, /primer.md) and 404s /trpc; "internal" serves ONLY
   * /trpc. Defaults to "public" so existing single-surface callers (and the
   * server factory's default) keep the agent surface.
   */
  surface?: RouteSurface;
}

export function createRouteHandler(
  deps: RouteDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { store, auth, maxBodyBytes, secretKey } = deps;
  const surface: RouteSurface = deps.surface ?? "public";

  // The tRPC adapter only serves the internal listener; the public one never
  // mounts it (defense by not-exposing, ADR 0008 P1).
  const trpcHandler =
    surface === "internal"
      ? createHTTPHandler({
          router: appRouter,
          createContext: createContextFactory({ store, auth, secretKey }),
          basePath: "/trpc/",
        })
      : null;

  return async function handle(req, res) {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);

      // Internal listener: the admin tRPC surface and nothing else. Anything
      // that isn't /trpc/* on this socket is not its job → 404.
      if (surface === "internal") {
        if (trpcHandler && url.pathname.startsWith("/trpc/")) {
          if (!isAllowedOrigin(req, auth)) {
            return sendJson(res, { error: "Origin not allowed" }, 403);
          }
          return trpcHandler(req, res);
        }
        return sendJson(res, { error: "Not found" }, 404);
      }

      // Public listener (the published port): agent surface only.

      if (req.method === "GET" && url.pathname === "/healthz") {
        // ADR 0008 P3: the admin token is no longer the /mcp gate — the agent
        // token is. Report MCP auth status off the AGENT credential (the bypass
        // = disabled), not the (now non-gating) admin token.
        const mcpAuth = !auth.allowNoAuth && (auth.agentToken || auth.agentTokenMap.size);
        // Capture status (spec 2026-06-16-harness-auto-capture, T5 / SC9): the
        // harness SessionStart banner reads this to tell the agent whether
        // automatic capture is live or warn (with the fix) when it is off.
        // `capture` is "enabled" iff the curator INTAKE gate that drains the
        // transcript buffer is on (the server-authoritative gate, spec §5 Q-gate)
        // — the same gate /transcript checks before buffering. It is a plain
        // boolean of an admin setting, no secret, so it is unauthenticated-safe
        // (like the rest of /healthz). `isIntakeEnabled` is fail-soft, but a
        // store-level throw (e.g. a transient DB read error) must NEVER turn the
        // container's HEALTHCHECK probe into a 500 — /healthz answering at all IS
        // the health signal. Default `capture` to "disabled" (the safe, no-leak
        // value) if the gate read throws.
        let captureEnabled = false;
        try {
          captureEnabled = isIntakeEnabled(store);
        } catch {
          captureEnabled = false;
        }
        return sendJson(res, {
          status: "ok",
          dashboard_auth: "disabled",
          mcp_auth: mcpAuth ? "enabled" : "disabled",
          auth: mcpAuth ? "enabled" : "disabled",
          agent_auth: auth.agentToken || auth.agentTokenMap.size ? "enabled" : "disabled",
          capture: captureEnabled ? "enabled" : "disabled",
        });
      }

      // The primer endpoint (rethink T11, spec §5.2): unauthenticated BY
      // DESIGN — OpenCode's remote-URL `instructions` config fetches it with
      // no way to attach a bearer. The auth bypass is scoped to exactly this
      // path; it serves only vault/primer.md, which must never interpolate
      // operator-specific or secret content. GET-only and, like /healthz,
      // ahead of the browser-origin gate (it is a public document).
      if (req.method === "GET" && url.pathname === "/primer.md") {
        res.writeHead(200, {
          "content-type": "text/markdown; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(readPrimer(store));
        return;
      }

      if (!isAllowedOrigin(req, auth)) return sendJson(res, { error: "Origin not allowed" }, 403);

      // /trpc/* is NOT served on the public listener (ADR 0008 P1): the admin
      // API lives on the internal listener. Fall through to the 404 floor so a
      // network peer can't reach an admin procedure here.

      if (url.pathname === "/mcp") {
        // Public surface: agent-role only — authenticatePublic has NO admin path
        // here, so /mcp can never resolve to admin (ADR 0008 P3). It also requires
        // `agent` SCOPE: a least-privilege capture token is FORBIDDEN (403), never
        // reaching the 7 verbs (ingest spec D21).
        const authed = authenticatePublic(req, auth, "agent");
        if (!authed.ok) return authed.status === 403 ? sendForbidden(res) : sendUnauthorized(res);
        const result = authed.result;
        if (req.method === "GET") {
          return sendJson(res, {
            status: "ok",
            transport: "json-rpc-http",
            message: "POST JSON-RPC MCP messages to this endpoint.",
          });
        }
        if (req.method !== "POST") return sendJson(res, { error: "Method not allowed" }, 405);
        const payload = await readJson(req, maxBodyBytes);
        const response = await handleMcpPayload(store, payload, {
          role: result.role,
          agentId: result.agentId,
        });
        if (response === null) return sendEmpty(res);
        return sendJson(res, response);
      }

      if (url.pathname === "/transcript") {
        // Harness-driven automatic capture (spec 2026-06-16-harness-auto-capture,
        // T1). Same agent-token auth as /mcp on this public surface — never admin
        // (ADR 0008 P3): a non-agent/unauthed caller 401s, mirroring /mcp. Requires
        // `agent` scope — a capture token is forbidden here (D21).
        const authed = authenticatePublic(req, auth, "agent");
        if (!authed.ok) return authed.status === 403 ? sendForbidden(res) : sendUnauthorized(res);
        if (req.method !== "POST") return sendJson(res, { error: "Method not allowed" }, 405);
        const payload = await readJson(req, maxBodyBytes);
        // The handler is fail-soft (validates, gate-checks, redacts, buffers) and
        // never throws — it returns the status + body to send.
        const intake = handleTranscriptIntake(store, payload);
        return sendJson(res, intake.body, intake.status);
      }

      if (url.pathname === "/ingest") {
        // Reference ingest (ingest spec D3): the browser-extension / mobile-share
        // endpoint. Requires `capture` SCOPE — an agent token (and the localhost
        // bypass's agent identity) is FORBIDDEN (403), the other direction of the
        // D21 wall; no/invalid credential is 401. The fetch/extract/write pipeline
        // lands in later tasks — this is the synchronous front door (D22): auth →
        // size cap → field-presence/`via` validation → write a `pending` log row →
        // 202 {status:"queued", id}. The row stays `pending` until a later task
        // adds background processing.
        const authed = authenticatePublic(req, auth, "capture");
        if (!authed.ok) return authed.status === 403 ? sendForbidden(res) : sendUnauthorized(res);
        if (req.method !== "POST") return sendJson(res, { error: "Method not allowed" }, 405);
        // `await` (not a bare `return`) so a readJson throw (413/400) rejects
        // INSIDE this try and is sent by the outer catch — a bare return would let
        // the rejection escape the handler and reset the socket.
        return await handleIngest(req, res, store, INGEST_MAX_BODY_BYTES, authed.result.tokenId);
      }

      sendJson(res, { error: "Not found" }, 404);
    } catch (error) {
      const err = error as Error & { statusCode?: number };
      sendJson(res, { error: err.message }, err.statusCode || 500);
    }
  };
}

// ---------- /ingest front door (ingest spec Task 3, D22) ----------

/**
 * Request-body cap for /ingest (ingest spec criterion 3 / D14). Independent of
 * the generic `LIBRARIAN_MAX_BODY_BYTES` (/mcp, /transcript) because a `content`
 * capture carries a full extracted article — ~2 MB headroom, not the 1 MB MCP
 * default. The EXTRACTED-markdown cap (~1 MB) is a different, post-fetch limit
 * applied in a later task (it is a logged failure, not a synchronous 413).
 */
const INGEST_MAX_BODY_BYTES = 2 * 1024 * 1024;

const INGEST_VIAS: readonly IngestVia[] = ["extension", "ios", "android"];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The synchronous /ingest pipeline (D22). Validates, writes a `pending` row, and
 * returns 202 — it never throws to the caller (fail-soft): every outcome is a
 * deliberate status with a teaching message. The size-cap (413) and malformed-JSON
 * (400) throws from {@link readJson} are caught by the route's outer try/catch,
 * which sends a clean JSON error (no stack trace, no secrets) — not a leak.
 */
async function handleIngest(
  req: IncomingMessage,
  res: ServerResponse,
  store: LibrarianStore,
  maxBodyBytes: number,
  tokenId: string | undefined,
): Promise<void> {
  // Size cap first (criterion 3): a >cap body is rejected before we buffer or
  // parse it. readJson streams + aborts over the cap (413) and 400s malformed JSON.
  const body = await readJson(req, maxBodyBytes, {
    tooLargeMessage: `Request body too large: the /ingest cap is ${Math.round(maxBodyBytes / (1024 * 1024))} MB`,
    drainOnOverflow: true,
  });

  // Field-presence dispatch (criterion 2 / D12): exactly which field is present
  // (content vs url vs text) drives the LATER write tasks — here we only require
  // at least one, and teach by naming all three.
  if (
    !isNonEmptyString(body.content) &&
    !isNonEmptyString(body.url) &&
    !isNonEmptyString(body.text)
  ) {
    return sendJson(
      res,
      {
        error:
          "Expected one of: content, url, text (a non-empty string). " +
          "Send `content` for pre-extracted markdown, `url` to fetch + extract, or `text` for a raw note.",
      },
      400,
    );
  }

  // `via` (D13 frontmatter): which client produced the capture. Validate against
  // the known set; default to `extension` when absent (the browser path is the
  // common case). A present-but-unknown value is a teaching 400, never silently
  // coerced — recordPending would otherwise reject it.
  const via = resolveVia(body.via);
  if (!via) {
    return sendJson(
      res,
      {
        error: `Expected 'via' to be one of: ${INGEST_VIAS.join(", ")} (or omitted, defaulting to extension)`,
      },
      400,
    );
  }

  // Per-token rate limit (criterion 10 / D19): a leaked capture token is the
  // threat, so the limiter keys on the specific tokenId — a daily quota + a short
  // burst cap, both counted in the durable settings sidecar. Over either limit →
  // 429 with a Retry-After header + a teaching body. Checked AFTER validation (a
  // malformed request shouldn't burn quota) and BEFORE writing the pending row (a
  // throttled request records nothing). Every /ingest caller is a DB-minted capture
  // token, so tokenId is present; the guard is belt-and-braces (env tokens and the
  // no-auth bypass are agent-scope and can't reach here).
  if (tokenId) {
    const limit = checkIngestRateLimit(store, tokenId);
    if (!limit.allowed) {
      return sendJson(
        res,
        {
          error:
            `Rate limit exceeded (${limit.reason}); slow down and retry in ` +
            `${limit.retryAfterSeconds}s. Each capture token is capped per day and per burst (D19).`,
          retry_after_seconds: limit.retryAfterSeconds,
        },
        429,
        { "retry-after": String(limit.retryAfterSeconds) },
      );
    }
  }

  // The dedup/crash-safety invariant (criterion 5 / D22): write a `pending` row
  // BEFORE the 202 so a crash before background processing still leaves a recorded
  // attempt. `source` is the url when present (the dedup key for url/content
  // captures) or a marker for a text/content-only capture; recordPending redacts
  // it (D25). The id is returned so a client can show "Queued ✓".
  const source = isNonEmptyString(body.url)
    ? body.url.trim()
    : isNonEmptyString(body.content)
      ? "content-capture"
      : "text-capture";
  const id = recordPending(store, { source, via });
  return sendJson(res, { status: "queued", id }, 202);
}

/** Resolve the body `via` to a known {@link IngestVia}, defaulting to extension when absent. */
function resolveVia(value: unknown): IngestVia | null {
  if (value === undefined || value === null || value === "") return "extension";
  return INGEST_VIAS.includes(value as IngestVia) ? (value as IngestVia) : null;
}

// ---------- HTTP IO helpers ----------

function sendJson(
  res: ServerResponse,
  payload: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function sendEmpty(res: ServerResponse): void {
  res.writeHead(202, { "cache-control": "no-store" });
  res.end();
}

function sendUnauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    "content-type": "application/json; charset=utf-8",
    "www-authenticate": "Bearer",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

// A valid credential of the WRONG scope (ingest spec D21): 403, not 401 — the
// caller authenticated but isn't permitted on this surface (capture token on
// /mcp, or agent token on /ingest). No `www-authenticate` challenge: presenting
// different agent credentials won't help; the scope is the gate.
function sendForbidden(res: ServerResponse): void {
  res.writeHead(403, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify({ error: "Forbidden: token scope not permitted on this endpoint" }));
}

async function readJson(
  req: IncomingMessage,
  maxBodyBytes: number,
  opts: { tooLargeMessage?: string; drainOnOverflow?: boolean } = {},
): Promise<Record<string, unknown>> {
  let body = "";
  let size = 0;
  let overflow = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      // Responding to an in-flight upload without consuming the rest of the body
      // makes Node RST the socket, so the client sees a connection reset instead
      // of the 413 (ingest spec criterion 3 wants a CLEAN status). When asked,
      // keep draining (discarding) the remainder so the 413 flushes — but bound
      // the drain so a malicious oversize upload can't tie up the socket forever.
      if (!opts.drainOnOverflow) {
        throw httpError(opts.tooLargeMessage ?? "Request body too large", 413);
      }
      overflow = true;
      if (size > maxBodyBytes * 8) {
        req.destroy();
        break;
      }
      continue;
    }
    body += chunk;
  }
  if (overflow) throw httpError(opts.tooLargeMessage ?? "Request body too large", 413);
  if (!body) return {};
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch (error) {
    throw httpError(`Invalid JSON body: ${(error as Error).message}`, 400);
  }
}

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

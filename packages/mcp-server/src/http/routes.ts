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
//
// Routing is a per-surface route TABLE, not an if-ladder (ADR 0011, spec 060 T1):
// each listener owns an ordered list of route entries `createRouteHandler` walks.
// Core routes are the entries below; plugin routes append to the same tables in a
// later task. The hand-rolled handler stays (no Express/Fastify) — the table is
// small, audited, and ADR 0008-shaped.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type IngestVia,
  type LibrarianStore,
  checkIngestRateLimit,
  isIntakeEnabled,
  markFailed,
  processContentCapture,
  processTextCapture,
  processUrlCapture,
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

/**
 * The per-request context handed to every route handler: the request pair plus
 * the deps a handler needs. A route entry closes over nothing else, so each
 * surface's routes are a plain declarative list — the structure plugin routes
 * append to (spec 060 T5); T1 only extracts the core routes into it.
 */
interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  store: LibrarianStore;
  auth: AuthConfig;
  maxBodyBytes: number;
}

/**
 * A route handler owns its own method handling and (for authenticated routes)
 * its own auth call — the if-ladder bodies moved verbatim, not rewritten. Sync
 * routes return void; the /mcp, /transcript, /ingest handlers are async and may
 * reject, which the walk's `await` funnels to the outer try/catch.
 */
type RouteHandler = (ctx: RouteContext) => Promise<void> | void;

interface Route {
  readonly match: (method: string | undefined, pathname: string) => boolean;
  readonly handle: RouteHandler;
}

/**
 * A public-surface route. `beforeOriginGate` marks the two unauthenticated
 * document routes (/healthz, /primer.md) that are served AHEAD of the browser-
 * origin gate; every other route — and the 404 floor — sits behind it.
 */
interface PublicRoute extends Route {
  readonly beforeOriginGate: boolean;
}

/** An internal-surface route (ADR 0008 P1: only /trpc/*). */
type InternalRoute = Route;

export function createRouteHandler(
  deps: RouteDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { store, auth, maxBodyBytes, secretKey } = deps;
  const surface: RouteSurface = deps.surface ?? "public";

  // The tRPC adapter only serves the internal listener; the public one never
  // mounts it (defense by not-exposing, ADR 0008 P1). Build the internal route
  // table (and its adapter) once, for the internal surface alone.
  const internalRoutes: readonly InternalRoute[] =
    surface === "internal" ? createInternalRoutes({ store, auth, secretKey }) : [];

  return async function handle(req, res) {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);
      const ctx: RouteContext = { req, res, store, auth, maxBodyBytes };

      // Internal listener: the admin tRPC surface and nothing else. Anything that
      // isn't a mounted route (only /trpc/*) on this socket is not its job → 404.
      if (surface === "internal") {
        for (const route of internalRoutes) {
          if (route.match(req.method, url.pathname)) return await route.handle(ctx);
        }
        return sendJson(res, { error: "Not found" }, 404);
      }

      // Public listener (the published port): agent surface only. The two
      // unauthenticated document routes (/healthz, /primer.md) are served ahead of
      // the browser-origin gate — a health probe or a remote-URL primer fetch
      // attaches no Origin and must still read them.
      for (const route of publicRoutes) {
        if (route.beforeOriginGate && route.match(req.method, url.pathname)) {
          return await route.handle(ctx);
        }
      }

      if (!isAllowedOrigin(req, auth)) return sendJson(res, { error: "Origin not allowed" }, 403);

      // /trpc/* is NOT served on the public listener (ADR 0008 P1): the admin API
      // lives on the internal listener. It is simply absent from `publicRoutes`, so
      // a network peer here — and any unknown path — falls through to the 404 floor
      // below (a disallowed origin already 403'd above) and can't reach an admin
      // procedure.
      for (const route of publicRoutes) {
        if (!route.beforeOriginGate && route.match(req.method, url.pathname)) {
          return await route.handle(ctx);
        }
      }

      sendJson(res, { error: "Not found" }, 404);
    } catch (error) {
      const err = error as Error & { statusCode?: number };
      sendJson(res, { error: err.message }, err.statusCode || 500);
    }
  };
}

/**
 * Build the internal listener's route table: the admin tRPC surface (ADR 0008 P1),
 * and nothing else. The tRPC adapter is constructed once here and closed over by
 * the returned route — a one-entry table plugin internal routes append to (spec
 * 060 T5).
 */
function createInternalRoutes(deps: {
  store: LibrarianStore;
  auth: AuthConfig;
  secretKey: Buffer | null;
}): readonly InternalRoute[] {
  const trpcHandler = createHTTPHandler({
    router: appRouter,
    createContext: createContextFactory({
      store: deps.store,
      auth: deps.auth,
      secretKey: deps.secretKey,
    }),
    basePath: "/trpc/",
  });
  return [
    {
      match: (_method, pathname) => pathname.startsWith("/trpc/"),
      handle: (ctx) => {
        // The internal listener is trusted by isolation (loopback / docker net,
        // never published — ADR 0008 P3), but the browser-origin gate still runs
        // before the tRPC adapter, exactly as the if-ladder did.
        if (!isAllowedOrigin(ctx.req, ctx.auth)) {
          return sendJson(ctx.res, { error: "Origin not allowed" }, 403);
        }
        return trpcHandler(ctx.req, ctx.res);
      },
    },
  ];
}

/**
 * The public listener's route table (the agent surface, ADR 0008 P1). Walked in
 * order by {@link createRouteHandler}: the two `beforeOriginGate` document routes
 * match first (served without the browser-origin gate), then the gate runs, then
 * the authenticated agent routes. The table plugin HTTP routes append to (spec
 * 060 T5); T1 only extracts the core routes into it.
 */
const publicRoutes: readonly PublicRoute[] = [
  {
    beforeOriginGate: true,
    match: (m, p) => m === "GET" && p === "/healthz",
    handle: handleHealthz,
  },
  {
    beforeOriginGate: true,
    match: (m, p) => m === "GET" && p === "/primer.md",
    handle: handlePrimer,
  },
  { beforeOriginGate: false, match: (_m, p) => p === "/mcp", handle: handleMcp },
  { beforeOriginGate: false, match: (_m, p) => p === "/transcript", handle: handleTranscript },
  { beforeOriginGate: false, match: (_m, p) => p === "/ingest", handle: handleIngestRoute },
];

function handleHealthz(ctx: RouteContext): void {
  const { auth, store, res } = ctx;
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

function handlePrimer(ctx: RouteContext): void {
  const { store, res } = ctx;
  // The primer endpoint (rethink T11, spec §5.2): unauthenticated BY
  // DESIGN — OpenCode's remote-URL `instructions` config fetches it with
  // no way to attach a bearer. The auth bypass is scoped to exactly this
  // path; it serves only vault/primer.md, which must never interpolate
  // operator-specific or secret content. GET-only and, like /healthz,
  // ahead of the browser-origin gate (it is a public document).
  res.writeHead(200, {
    "content-type": "text/markdown; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(readPrimer(store));
}

async function handleMcp(ctx: RouteContext): Promise<void> {
  const { req, res, store, auth, maxBodyBytes } = ctx;
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

async function handleTranscript(ctx: RouteContext): Promise<void> {
  const { req, res, store, auth, maxBodyBytes } = ctx;
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

async function handleIngestRoute(ctx: RouteContext): Promise<void> {
  const { req, res, store, auth } = ctx;
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
  // `await` (not a bare `return`) so a readJson throw (413/400) rejects while
  // still inside the route walk's try/catch and is sent by the outer catch — a
  // bare return would let the rejection escape the handler and reset the socket.
  return await handleIngest(req, res, store, INGEST_MAX_BODY_BYTES, authed.result.tokenId);
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
  sendJson(res, { status: "queued", id }, 202);

  // Background processing (D22): the heavy write runs AFTER the 202 so the client
  // is never blocked, and a failure here is LOGGED, never returned. Field-presence
  // (D12) picks the branch: `content` carries pre-extracted markdown (no fetch),
  // a bare `url` is fetched + extracted server-side (SSRF-guarded, Task 6), and
  // `text` is a raw note (no fetch, no dedup, no source). `content` wins when both
  // are present (it is the richer capture); `url` is the mobile share path.
  // `setImmediate` defers the work past this response's flush + handler return.
  // Each processor is itself fail-soft (records failures via markFailed and
  // resolves rather than throwing); the `.catch` is belt-and-braces so an
  // unexpected rejection can't escape as an unhandled promise.
  if (isNonEmptyString(body.content)) {
    const input = {
      content: body.content,
      ...(isNonEmptyString(body.url) ? { url: body.url.trim() } : {}),
      ...(isNonEmptyString(body.title) ? { title: body.title } : {}),
      // Forward the extension's extracted site/byline (D13) so a client-side
      // (Defuddle-in-browser) capture populates the same frontmatter the
      // server-fetch path does. processContentCapture already accepts them.
      ...(isNonEmptyString(body.site) ? { site: body.site } : {}),
      ...(isNonEmptyString(body.byline) ? { byline: body.byline } : {}),
      via,
    };
    setImmediate(() => {
      processContentCapture(store, input, id).catch((error) => {
        failBackground(store, id, error);
      });
    });
  } else if (isNonEmptyString(body.url)) {
    // url-only capture (D1/D23): the server fetches + extracts. processUrlCapture
    // owns the SSRF-guarded fetch (resolved-IP deny-list, socket pinning, per-hop
    // re-validation, body cap, text/html gate) and is itself fail-soft — every
    // refusal/error is recorded via markFailed and it never throws.
    const input = { url: body.url.trim(), via };
    setImmediate(() => {
      processUrlCapture(store, input, id).catch((error) => {
        failBackground(store, id, error);
      });
    });
  } else if (isNonEmptyString(body.text)) {
    const input = { text: body.text, via };
    setImmediate(() => {
      processTextCapture(store, input, id).catch((error) => {
        failBackground(store, id, error);
      });
    });
  }
}

/**
 * Belt-and-braces failure record for a background capture processor that somehow
 * rejected (the processors are fail-soft and shouldn't, but an unhandled rejection
 * must never escape a fire-and-forget turn). The markFailed write is itself
 * wrapped — if even that throws there is nothing more we can safely do.
 */
function failBackground(store: LibrarianStore, id: string, error: unknown): void {
  try {
    markFailed(store, id, error instanceof Error ? error.message : String(error));
  } catch {
    // The log write itself failed — nothing more to do from a background turn.
  }
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

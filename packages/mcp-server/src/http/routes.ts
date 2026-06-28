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
import { type LibrarianStore, isIntakeEnabled, readPrimer } from "@librarian/core";
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
        // D21 wall; no/invalid credential is 401. The real fetch/extract/write
        // pipeline lands in later tasks — this stub only proves the auth boundary,
        // returning 202 (the endpoint is async by design, D22) on a valid capture
        // token.
        const authed = authenticatePublic(req, auth, "capture");
        if (!authed.ok) return authed.status === 403 ? sendForbidden(res) : sendUnauthorized(res);
        if (req.method !== "POST") return sendJson(res, { error: "Method not allowed" }, 405);
        return sendJson(res, { status: "accepted" }, 202);
      }

      sendJson(res, { error: "Not found" }, 404);
    } catch (error) {
      const err = error as Error & { statusCode?: number };
      sendJson(res, { error: err.message }, err.statusCode || 500);
    }
  };
}

// ---------- HTTP IO helpers ----------

function sendJson(res: ServerResponse, payload: unknown, status = 200): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
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
): Promise<Record<string, unknown>> {
  let body = "";
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw httpError("Request body too large", 413);
    body += chunk;
  }
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

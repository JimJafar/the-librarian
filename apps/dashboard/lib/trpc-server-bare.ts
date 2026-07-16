import "server-only";
import type { AppRouter } from "@librarian/mcp-server";
import { createTRPCClient, httpBatchLink } from "@trpc/client";

const DEFAULT_SERVER_URL = "http://127.0.0.1:3838";

// ADR 0008 P2/P3: the admin tRPC API lives on its OWN internal listener, on a
// different host:port from the agent /mcp surface, and is TRUSTED — it grants
// admin with no bearer because it's reachable only over loopback / the internal
// docker network. So the dashboard's tRPC clients target LIBRARIAN_TRPC_URL (the
// base URL of that internal listener; we append /trpc below) and send NO
// Authorization header. LIBRARIAN_TRPC_URL wins; LIBRARIAN_SERVER_URL is kept
// only as the dev fallback so a plain local run against a single server resolves.
export function resolveTrpcBaseUrl(): string {
  return process.env.LIBRARIAN_TRPC_URL ?? process.env.LIBRARIAN_SERVER_URL ?? DEFAULT_SERVER_URL;
}

// Surface misconfiguration once at cold start so admin tRPC calls
// don't silently fall back to the dev default without a clue why.
//
// EDGE-SAFE: despite `import "server-only"`, Next's middleware bundler pulls
// this module into the EDGE runtime (middleware.ts → auth-config-client.ts →
// here), where `process.stderr` is undefined — a `process.stderr.write` at
// module init would throw and 500 every request. `console.warn` is supported in
// the edge runtime, so use it (never `process.stderr`/`process.stdout` here).
if (!process.env.LIBRARIAN_TRPC_URL && !process.env.LIBRARIAN_SERVER_URL) {
  console.warn(
    `[trpc-server] LIBRARIAN_TRPC_URL (and LIBRARIAN_SERVER_URL fallback) unset; ` +
      `falling back to ${DEFAULT_SERVER_URL} (dev only).`,
  );
}

// The BARE bootstrap client (spec 065 SC 3 / §4 "two clients"). NO identity headers callback —
// deliberately, twice over:
//
//   1. The circularity: `auth()`'s lazy config resolves through the auth-config fetch; an identity
//      callback CALLS `auth()`. One client with an identity callback would therefore await the very
//      in-flight config promise it is blocking — a circular await that re-arms on every cache
//      expiry, degrading to an abort and a headerless (⇒ machine-trust) request. The bare client
//      breaks the cycle (spec 065 §7 pass 1, blocking).
//   2. The trust model: the flows riding this client ARE machine calls whose credentials are
//      out-of-band — the auth-config fetch (process trust; four sessionless entry points, covered
//      module-wide in auth-config-client.ts), the credentials `verifyPassword` call (its credential
//      IS the password being verified), and the break-glass reset's `redeemSetupLink` (its
//      credential is the single-use, short-TTL, store-validated link token). An ABSENT assertion
//      retains today's isolation trust (ADR 0008 P3) exactly so these pre-session flows keep
//      working under a member-aware provider; asserting anonymity here would break sign-in and
//      account recovery in every member-aware deployment (spec 065 §1 / SC 9).
//
// EVERYTHING ELSE rides `serverTRPC` (lib/trpc-server.ts), which asserts identity per request.
// Adding a new bootstrap consumer to this client is a TRUST decision — it speaks with machine
// trust — so don't, unless its credential is genuinely out-of-band like the three above.
export function createBareServerTRPC() {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${resolveTrpcBaseUrl()}/trpc`,
      }),
    ],
  });
}

export const bareServerTRPC = createBareServerTRPC();

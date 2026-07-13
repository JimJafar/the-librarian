// `@librarian/mcp-server/extension` — the build-time plugin seam surface.
//
// This subpath entrypoint publishes the types a build-time extension needs to write
// a `LibrarianPlugin` and hand it to `createLibrarianServer` (ADR 0011 seam S1, spec
// 060). A plugin is an IMPORTED object composed at build time — there is no dynamic
// loading — so importing these types is the whole contract; the factory does the rest.
//
// EXPERIMENTAL until spec 062 lands. The ADR 0011 semver promise for THIS extension
// surface starts at the 062 release: until then the shapes here may change without a
// major bump. As of spec 061 the AUTH provider seam types are REAL and published below
// (`Principal` from `@librarian/core`, plus `AuthProvider`/`AuthProviderResult`/
// `SyncAuthProvider`). Only the VAULT provider seam (`vaultRouter`) is still a placeholder
// — its owned, stable types (Shelf/VaultRouter) join this entrypoint when spec 062 lands.
// No `any` appears on this surface (ADR 0003).

// The plugin envelope + the tRPC registration shape.
export type { LibrarianPlugin, PluginTrpcRouters } from "./plugin.js";

// The MCP tool registration shape and the context its handler receives.
export type { ToolContext, ToolDefinition } from "./mcp/tool.js";

// The HTTP route registration shapes (surface + auth contract, spec 060 T5).
export type {
  PluginRoute,
  PluginRouteAuth,
  PluginRouteContext,
  PluginRouteHandler,
  PluginRouteMethod,
} from "./http/routes.js";

// The auth PROVIDER seam — its owned, stable types are now real (spec 061, ADR 0011 Decision 3).
// `Principal` is the one identity currency threaded from listener to store write; it is owned by
// and re-exported from `@librarian/core` (it lives next to `caller-identity`, which the store
// consumes). `AuthProvider` is the async-capable "who is this request?" seam a plugin fills to
// replace the OSS default; `SyncAuthProvider` is the synchronous shape that default returns; and
// `AuthProviderResult` is their discriminated outcome (a `Principal`, or a 401/403 refusal — the
// wire distinction a bare `Principal | null` could not carry).
export type { Principal } from "@librarian/core";
export type { AuthProvider, AuthProviderResult, SyncAuthProvider } from "./http/auth.js";

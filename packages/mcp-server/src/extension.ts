// `@librarian/mcp-server/extension` — the build-time plugin seam surface.
//
// This subpath entrypoint publishes the types a build-time extension needs to write
// a `LibrarianPlugin` and hand it to `createLibrarianServer` (ADR 0011 seam S1, spec
// 060). A plugin is an IMPORTED object composed at build time — there is no dynamic
// loading — so importing these types is the whole contract; the factory does the rest.
//
// EXPERIMENTAL until the spec 062 RELEASE. The ADR 0011 semver promise for THIS extension
// surface starts at that release (062's final task): until then the shapes here may change
// without a major bump — the marker does NOT drop at 062 T1. As of spec 061 the AUTH provider
// seam types are REAL (`Principal` from `@librarian/core`, plus `AuthProvider`/
// `AuthProviderResult`/`SyncAuthProvider`); as of spec 062 T1 the VAULT provider seam types are
// REAL too (`Shelf`/`ShelfOp`/`VaultRouter` from `@librarian/core`) — both published below.
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

// The vault-router PROVIDER seam — its owned, stable types are real (spec 062 T1, ADR 0011
// Decision 3/5). `VaultRouter` is the "which shelves does this principal see, and where do writes
// land?" seam a plugin fills to replace the OSS `defaultVaultRouter`; `Shelf` is one rooted prefix
// (a subtree of the single vault repo) with its id/writability; `ShelfOp` is the operation a shelf
// set is resolved for (`recall` | `search` | `write` | `groom`). All three are owned by and
// re-exported from `@librarian/core` (they live next to Principal, which the store also consumes).
export type { Shelf, ShelfOp, VaultRouter } from "@librarian/core";

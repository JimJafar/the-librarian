// `@librarian/mcp-server/extension` — the build-time plugin seam surface.
//
// This subpath entrypoint publishes the types a build-time extension needs to write
// a `LibrarianPlugin` and hand it to `createLibrarianServer` (ADR 0011 seam S1, spec
// 060). A plugin is an IMPORTED object composed at build time — there is no dynamic
// loading — so importing these types is the whole contract; the factory does the rest.
//
// EXPERIMENTAL until spec 062 lands. The ADR 0011 semver promise for THIS extension
// surface starts at the 062 release: until then the shapes here may change without a
// major bump (the 061/062 provider interfaces are still being built). That is why the
// two PROVIDER placeholders (`authProvider` / `vaultRouter`) are DELIBERATELY not
// exported here — their owned, stable types (Principal/AuthProvider from 061,
// Shelf/VaultRouter from 062) join this entrypoint when their specs land. No `any`
// appears on this surface (ADR 0003).

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

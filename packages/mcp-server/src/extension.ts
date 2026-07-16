// `@librarian/mcp-server/extension` — the build-time plugin seam surface.
//
// This subpath entrypoint publishes the types a build-time extension needs to write
// a `LibrarianPlugin` and hand it to `createLibrarianServer` (ADR 0011 seam S1, spec
// 060). A plugin is an IMPORTED object composed at build time — there is no dynamic
// loading — so importing these types is the whole contract; the factory does the rest.
//
// STABLE as of the spec 062 release (ADR 0011 Decision 6). This extension surface now carries
// the ADR 0011 semver promise: a breaking change to any type or value published here is a MAJOR
// version bump documented in the CHANGELOG — build against it and pin your major, no more. The
// experimental marker DROPS here; everything NOT exported through this entrypoint stays private
// and refactorable at will (the point of a small stable surface). Published below: the plugin
// envelope + registration shapes (spec 060), the AUTH provider seam (`Principal` from
// `@librarian/core`, plus `AuthProvider`/`AuthProviderResult`/`SyncAuthProvider`, spec 061), and
// the VAULT provider seam (`Shelf`/`ShelfOp`/`VaultRouter` + the two typed write errors from
// `@librarian/core`, spec 062). No `any` appears on this surface (ADR 0003).

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

// The vault-router PROVIDER seam — its owned, stable types are real (spec 062, ADR 0011
// Decision 3/5). `VaultRouter` is the "which shelves does this principal see, and where do writes
// land?" seam a plugin fills to replace the OSS `defaultVaultRouter`; `Shelf` is one rooted prefix
// (a subtree of the single vault repo) with its id/writability; `ShelfOp` is the operation a shelf
// set is resolved for (`recall` | `search` | `write` | `groom`). All three are owned by and
// re-exported from `@librarian/core` (they live next to Principal, which the store also consumes).
export type { Shelf, ShelfOp, VaultRouter } from "@librarian/core";

// The dashboard IDENTITY-ASSERTION contract (spec 065 SC 11, ADR 0011 Decision 3). The dashboard
// process voluntarily narrows a request to its signed-in user via one header on the internal
// listener; a member-aware `authProvider` reads it with `readDashboardUser` and maps the four-way
// {@link DashboardAssertion} to a principal by SC 9's table (the OSS default IGNORES it —
// byte-identical, SC 4). `readDashboardUser` is a VALUE (the parser IS the security boundary, SC 11:
// everything not positively one of the two claim shapes is `invalid`, never `absent`); the header
// name and the poison marker are exported constants a plugin's tests and any setter reference.
export {
  DASHBOARD_USER_HEADER,
  DASHBOARD_USER_POISON,
  readDashboardUser,
} from "./http/dashboard-user.js";
export type { DashboardAssertion, DashboardUser } from "./http/dashboard-user.js";

// The two typed WRITE errors a router / handler author catches (spec 062 T3 / SC 6). These are
// VALUES (error classes), not just types — a plugin surfacing its own write UX (`instanceof`, a
// message, a re-thrown wire error) needs the runtime constructor. `ShelfNotWritableError` is thrown
// when a principal's `writeTarget` resolves to a `writable: false` shelf (a read-only team shelf);
// `ShelfNotInWriteSetError` when `writeTarget` returns a shelf that is NOT among the principal's
// `shelves(principal, "write")` set — the "where writes land" and "what may be written" axes must
// agree. The OSS MCP/tRPC boundaries already map both to a clean error; a plugin catches them to do
// the same on its own surface. (`RecalledMemory` and `GroomingStore` stay core-internal: a
// VaultRouter author's signatures never name them — the store consumes them, not the router — so
// they are NOT published here, per the ADR 0011 "smallest stable surface" rule.)
export { ShelfNotInWriteSetError, ShelfNotWritableError } from "@librarian/core";

// The `@librarian/mcp-server/extension` seam surface (spec 060 T6, SC 9).
//
// Imports the seam types the way an EXTENSION AUTHOR would — through the published
// package subpath, exercising the package.json `exports` map (`./extension` →
// `dist/extension.js`), not a relative `../dist` path. Builds a fully-typed
// `LibrarianPlugin` from the exported shapes to prove they compose from a consumer's
// perspective, and asserts the built entrypoint resolves + loads at runtime.
//
// Note on the repo's test setup: Vitest transpiles with esbuild (types stripped, not
// checked), and the package tsconfig excludes `tests/`, so the compile-time proof that
// the surface has no `any` and no leaked private names is `pnpm build` emitting
// `dist/extension.d.ts`. This test is the runtime-resolution + shape half.

// Side-effect import: forces Node/Vitest to resolve the `./extension` subpath through
// the exports map and load the built module (type-only imports below are erased).
import "@librarian/mcp-server/extension";
import type { IncomingMessage } from "node:http";
import type {
  AuthProvider,
  AuthProviderResult,
  LibrarianPlugin,
  Principal,
  PluginRoute,
  PluginRouteAuth,
  PluginRouteContext,
  PluginRouteHandler,
  PluginRouteMethod,
  PluginTrpcRouters,
  Shelf,
  ShelfOp,
  SyncAuthProvider,
  ToolContext,
  ToolDefinition,
  VaultRouter,
} from "@librarian/mcp-server/extension";
import { describe, expect, it } from "vitest";

describe("extension entrypoint — the plugin seam surface (spec 060 SC 9)", () => {
  it("composes a well-formed LibrarianPlugin from the exported shapes", () => {
    // MCP tool registration shape — its handler receives the exported ToolContext and
    // returns the MCP text-result shape structurally (no need to name McpTextResult).
    const tool: ToolDefinition = {
      name: "overlay_ping",
      description: "A demo extension tool.",
      inputSchema: { type: "object", properties: {} },
      handler: (_store, args, context: ToolContext) => ({
        content: [{ type: "text", text: `${context.role}:${JSON.stringify(args)}` }],
      }),
    };

    // HTTP route registration shapes — method/auth/context/handler all exported.
    const method: PluginRouteMethod = "GET";
    const auth: PluginRouteAuth = "agent";
    const handler: PluginRouteHandler = (ctx: PluginRouteContext) => {
      ctx.res.writeHead(200, { "content-type": "application/json" });
      ctx.res.end(JSON.stringify({ role: ctx.auth?.role ?? null }));
    };
    const route: PluginRoute = { path: "/overlay/ping", method, surface: "public", auth, handler };

    // tRPC registration shape — a plugin's routers, keyed by name. Empty here (a real
    // router is a runtime value); the point is the exported TYPE composes.
    const trpcRouters: PluginTrpcRouters = {};

    const plugin: LibrarianPlugin = {
      name: "overlay",
      tools: [tool],
      routes: [route],
      trpcRouters,
    };

    expect(plugin.name).toBe("overlay");
    expect(plugin.tools?.[0]?.name).toBe("overlay_ping");
    expect(plugin.routes?.[0]?.surface).toBe("public");
    expect(Object.keys(plugin.trpcRouters ?? {})).toHaveLength(0);
  });

  it("composes a typed member auth provider from the exported seam types (spec 061)", () => {
    // A member-aware plugin fills the AuthProvider seam ("who is this request?"): it resolves
    // a request to a CUSTOM-kind Principal (`kind: "member"`, `roles: ["agent"]`) that carries
    // its memberId in the free-form `attrs` and a real credential binding in `boundActorId`.
    // The OSS default is synchronous, so the object is typed `SyncAuthProvider` — proving that
    // shape composes AND that it widens to the async-capable `AuthProvider` seam below.
    const memberProvider: SyncAuthProvider = {
      authenticate(_req: IncomingMessage, surface, _requiredScope): AuthProviderResult {
        if (surface === "internal") {
          const admin: Principal = { kind: "admin", actorId: "dashboard-admin", roles: ["admin"] };
          return { ok: true, principal: admin };
        }
        const member: Principal = {
          kind: "member",
          actorId: "member-sarah",
          boundActorId: "member-sarah",
          roles: ["agent"],
          scope: "agent",
          attrs: { memberId: "sarah" },
        };
        return { ok: true, principal: member };
      },
    };

    // Return-type covariance: a SyncAuthProvider is assignable to the async-capable seam, so the
    // default and a guarded plugin provider share every consumption site (spec 061 SC 2 note).
    const seam: AuthProvider = memberProvider;
    void seam;

    const outcome = memberProvider.authenticate({ headers: {} } as IncomingMessage, "public");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    const principal: Principal = outcome.principal;
    expect(principal.kind).toBe("member");
    expect(principal.actorId).toBe("member-sarah");
    expect(principal.boundActorId).toBe("member-sarah");
    expect(principal.attrs?.memberId).toBe("sarah");
    expect(principal.roles).toContain("agent");
  });

  it("composes a typed vault router from the exported seam types (spec 062)", () => {
    // A member-aware plugin fills the VaultRouter seam ("which shelves + where do writes land?"):
    // a writable personal shelf plus a read-only, labelled team shelf, mapped per ShelfOp — the
    // Teams shape. Proves Shelf/ShelfOp/VaultRouter compose from a consumer's perspective and
    // slot into the LibrarianPlugin envelope.
    const principal: Principal = { kind: "member", actorId: "member-sarah", roles: ["agent"] };
    const personal: Shelf = { id: "personal", prefix: "members/sarah/", writable: true };
    const team: Shelf = { id: "team", prefix: "team/", writable: false, label: "Team" };
    const router: VaultRouter = {
      // writes see only the writable personal shelf; every other op merges [personal, team].
      shelves: (_principal, op: ShelfOp) => (op === "write" ? [personal] : [personal, team]),
      writeTarget: () => personal,
    };
    const plugin: LibrarianPlugin = { name: "overlay", vaultRouter: router };

    expect(plugin.vaultRouter?.writeTarget(principal).id).toBe("personal");
    expect(router.shelves(principal, "recall")).toHaveLength(2);
    expect(router.shelves(principal, "write")).toHaveLength(1);
    expect(router.shelves(principal, "recall")[1]?.label).toBe("Team");
  });
});

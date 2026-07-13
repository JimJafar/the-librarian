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
import type {
  LibrarianPlugin,
  PluginRoute,
  PluginRouteAuth,
  PluginRouteContext,
  PluginRouteHandler,
  PluginRouteMethod,
  PluginTrpcRouters,
  ToolContext,
  ToolDefinition,
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
});

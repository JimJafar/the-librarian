// The Librarian build-time plugin envelope (spec 060 T3–T4, ADR 0011 seam S1).
//
// A `LibrarianPlugin` is an IMPORTED object handed to `createLibrarianServer` —
// no dynamic discovery, no plugin directory, no runtime install (ADR 0011 §2):
// composition is a deliberate code change in whoever owns the entrypoint. It
// carries two registration seams so far — MCP `tools` (T3) and `trpcRouters`
// (T4); the `routes` (T5) and auth/vault provider (T6) slots arrive in later 060
// tasks — do NOT add those fields here before their task.

import type { AnyRouter } from "@trpc/server";
import type { ToolDefinition, ToolRegistry } from "./mcp/tool.js";
import { coreToolRegistry } from "./mcp/tools/index.js";
import { appRouter, coreRouterRecord } from "./trpc/router.js";
import { router } from "./trpc/trpc.js";

export interface LibrarianPlugin {
  /**
   * Unique registry key. Two registered plugins sharing a `name` is a boot error
   * ({@link assertUniquePluginNames}): the name IS the registry key, and spec 060
   * T4 mounts each plugin's tRPC router under it as a namespace, so it must be
   * unique across the registered set.
   */
  readonly name: string;
  /**
   * MCP tools this plugin contributes. They JOIN the core registry: each appears
   * in `tools/list` with the SAME role-filtering core tools get (an agent never
   * sees an `adminOnly` tool), dispatches through `tools/call`, and receives the
   * identical `(store, args, context)` handler contract (spec 060 SC 4). A tool
   * whose `name` collides with a core tool or another plugin's tool is a boot error
   * ({@link buildToolRegistry}) — registrations ADD, they never silently override.
   *
   * adminOnly is DEAD SURFACE over HTTP today (SC 4): registering an `adminOnly`
   * tool is legal, but it is currently UNREACHABLE on either HTTP listener — the
   * public surface never resolves to the admin role (`http/auth.ts:75-79`) and the
   * internal listener serves no `/mcp`. So an `adminOnly` plugin tool lists and
   * dispatches only for an admin caller off the network (e.g. the stdio bin with
   * `LIBRARIAN_STDIO_ROLE=admin`), not over HTTP — until a future spec gives the
   * admin role an HTTP path. (The full extension docs page is spec 060 T6; this
   * note carries the caveat until then.)
   */
  readonly tools?: readonly ToolDefinition[];
  /**
   * tRPC routers this plugin contributes to the admin API. Every entry is mounted
   * under the plugin's `name` as a namespace, using the SAME `router({ ... })`
   * nesting the core's 16 feature routers use — no new tRPC API (ADR 0011,
   * "tRPC merge by nesting"). A plugin `{ name: "teams", trpcRouters: { members:
   * membersRouter } }` therefore serves its procedures at `appRouter.teams.members.*`
   * ({@link buildAppRouter}), reachable on the INTERNAL listener only (the admin
   * tRPC surface, ADR 0008 P1) — a plugin procedure 404s on the public listener
   * exactly as the core routers do.
   *
   * The plugin `name` IS the tRPC namespace, so it may not shadow a top-level core
   * router key (`health`, `memories`, …): a collision is a construction-time boot
   * error ({@link assertNoCoreNamespaceCollision}) naming the plugin — registrations
   * add, they never override (spec 060 SC 7). With no plugin supplying `trpcRouters`
   * the runtime router is the core `appRouter` object unchanged, so the dashboard's
   * `AppRouter` contract — which stays the CORE router type — is untouched.
   *
   * Procedures receive the existing `TrpcContext` (role + store) as-is; the
   * Principal identity currency (ADR 0011 §4) arrives in spec 061.
   */
  readonly trpcRouters?: Readonly<Record<string, AnyRouter>>;
}

/** The core top-level tRPC namespaces a plugin name may not shadow (spec 060 SC 7). */
const CORE_ROUTER_NAMESPACES: ReadonlySet<string> = new Set(Object.keys(coreRouterRecord));

/**
 * Assert no plugin's `name` collides with a top-level CORE tRPC router namespace
 * (`health`, `memories`, …). Throws (a construction-time boot error) naming the
 * offending plugin. The factory calls this before opening the store, alongside
 * {@link assertUniquePluginNames} (which refuses plugin-vs-plugin name collisions),
 * so a namespace that would shadow a core router can never reach the router merge
 * (spec 060 SC 7) — registrations add, they never override. The check is on the
 * NAME, not on whether the plugin supplies `trpcRouters`: the name reserves the
 * namespace regardless (a tools-only plugin named `health` is refused just the same).
 */
export function assertNoCoreNamespaceCollision(plugins: readonly LibrarianPlugin[]): void {
  for (const plugin of plugins) {
    if (CORE_ROUTER_NAMESPACES.has(plugin.name)) {
      throw new Error(
        `Plugin "${plugin.name}" collides with the core tRPC router namespace "${plugin.name}". ` +
          `A plugin name IS its tRPC namespace (appRouter.<name>.*, spec 060 T4) and must not shadow ` +
          `a core router — registrations add, they never override (spec 060 SC 7).`,
      );
    }
  }
}

/**
 * Build the tRPC router the internal listener serves: the core `appRouter`'s
 * namespaces plus each plugin's `trpcRouters`, mounted under the plugin's `name`
 * via the SAME `router({ ... })` nesting the core uses (ADR 0011, "tRPC merge by
 * nesting" — no new tRPC API). Name collisions (plugin-vs-core, plugin-vs-plugin)
 * are refused BEFORE this runs ({@link assertNoCoreNamespaceCollision} +
 * {@link assertUniquePluginNames}), so the merge here is collision-free.
 *
 * With no plugin supplying `trpcRouters` it returns the core `appRouter` OBJECT
 * unchanged — the default admin surface is byte-identical (the same instance the
 * non-factory internal-listener path builds its adapter from), and the dashboard's
 * `AppRouter` type is untouched. The return is typed `AnyRouter` (the tRPC library
 * type): the STATIC public contract stays the core `AppRouter`; plugin procedures
 * extend the RUNTIME router only.
 */
export function buildAppRouter(plugins: readonly LibrarianPlugin[]): AnyRouter {
  const namespaces: Record<string, AnyRouter> = {};
  for (const plugin of plugins) {
    if (plugin.trpcRouters === undefined) continue;
    namespaces[plugin.name] = router(plugin.trpcRouters);
  }

  // No plugin mounted a tRPC router — hand back the shared core appRouter object so
  // the default admin surface is literally the same instance every non-factory path
  // serves (and the AppRouter contract is untouched).
  if (Object.keys(namespaces).length === 0) return appRouter;
  return router({ ...coreRouterRecord, ...namespaces });
}

/**
 * Assert every plugin has a distinct `name`. Throws (a construction-time boot
 * error) naming the offending name. The factory calls this before any
 * registration, so a duplicate namespace can never reach the tool / router /
 * route registries (spec 060 SC 7).
 */
export function assertUniquePluginNames(plugins: readonly LibrarianPlugin[]): void {
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (seen.has(plugin.name)) {
      throw new Error(
        `Plugin name collision: two registered plugins share the name "${plugin.name}". ` +
          `Plugin names are the registry key (a tRPC namespace in spec 060 T4) and must be unique.`,
      );
    }
    seen.add(plugin.name);
  }
}

/**
 * Build the MCP tool registry the HTTP factory dispatches through: the core tools
 * followed by every plugin's tools, in registration order (spec 060 SC 4). Throws
 * (a construction-time boot error) naming the offending PLUGIN on any tool-name
 * collision — plugin vs core, or plugin vs an earlier plugin — so a registration
 * can never silently override another tool (SC 7). With no plugin tools it returns
 * the core registry object unchanged, so the default tool surface is byte-identical.
 */
export function buildToolRegistry(plugins: readonly LibrarianPlugin[]): ToolRegistry {
  // name → human-readable owner, so a collision message can name BOTH the offending
  // plugin and who already holds the name (the core registry, or an earlier plugin).
  const owners = new Map<string, string>();
  for (const tool of coreToolRegistry.tools) owners.set(tool.name, "the core registry");

  const merged: ToolDefinition[] = [...coreToolRegistry.tools];
  let added = false;
  for (const plugin of plugins) {
    for (const tool of plugin.tools ?? []) {
      const owner = owners.get(tool.name);
      if (owner !== undefined) {
        throw new Error(
          `Plugin "${plugin.name}" registers a tool named "${tool.name}", which is already ` +
            `registered by ${owner}. Tool names must be unique across the registry — ` +
            `registrations add, they never override (spec 060 SC 7).`,
        );
      }
      owners.set(tool.name, `plugin "${plugin.name}"`);
      merged.push(tool);
      added = true;
    }
  }

  // No plugin contributed a tool — hand back the shared core registry object so the
  // default surface is literally the same instance the non-factory paths use.
  if (!added) return coreToolRegistry;
  return { tools: merged, byName: new Map(merged.map((tool) => [tool.name, tool])) };
}

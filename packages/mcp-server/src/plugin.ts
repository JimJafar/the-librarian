// The Librarian build-time plugin envelope (spec 060 T3, ADR 0011 seam S1).
//
// A `LibrarianPlugin` is an IMPORTED object handed to `createLibrarianServer` —
// no dynamic discovery, no plugin directory, no runtime install (ADR 0011 §2):
// composition is a deliberate code change in whoever owns the entrypoint. This
// task introduces the envelope and its first registration seam, MCP tools; the
// `trpcRouters` (T4), `routes` (T5), and auth/vault provider (T6) slots arrive in
// later 060 tasks — do NOT add those fields here before their task.

import type { ToolDefinition, ToolRegistry } from "./mcp/tool.js";
import { coreToolRegistry } from "./mcp/tools/index.js";

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

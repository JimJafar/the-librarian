// The Librarian build-time plugin envelope (spec 060, ADR 0011 seam S1).
//
// A `LibrarianPlugin` is an IMPORTED object handed to `createLibrarianServer` —
// no dynamic discovery, no plugin directory, no runtime install (ADR 0011 §2):
// composition is a deliberate code change in whoever owns the entrypoint. It
// carries three REGISTRATION seams that ADD to a registry — MCP `tools` (T3),
// `trpcRouters` (T4), HTTP `routes` (T5) — and two PROVIDER seams that REPLACE a
// default — `authProvider` and `vaultRouter` (T6, ADR 0011 Decision 3). The
// provider seams are typed as explicitly pre-stabilisation PLACEHOLDERS: their
// real shapes are owned by later specs (Principal/AuthProvider by 061,
// Shelf/VaultRouter by 062), so 060 neither defines nor publishes them — the
// placeholders below are experimental and are NOT re-exported through the
// `@librarian/mcp-server/extension` entrypoint.

import type { IncomingMessage } from "node:http";
import type { Principal, TokenScope } from "@librarian/core";
import type { AnyRouter } from "@trpc/server";
import type { AuthProvider, AuthProviderResult } from "./http/auth.js";
import type { PluginRoute, RouteSurface } from "./http/routes.js";
import type { ToolDefinition, ToolRegistry } from "./mcp/tool.js";
import { coreToolRegistry } from "./mcp/tools/index.js";
import { appRouter, coreRouterRecord } from "./trpc/router.js";
import { router } from "./trpc/trpc.js";

/**
 * The tRPC registration shape (spec 060 T4): a plugin's routers, each mounted under
 * the plugin's `name` as a namespace. A named alias for the `trpcRouters` field so
 * the extension entrypoint can publish it. `AnyRouter` is the tRPC library's router
 * type (not `any`) — the plugin supplies concrete routers; the merged runtime router
 * is widened to it while the STATIC dashboard contract stays the core `AppRouter`.
 */
export type PluginTrpcRouters = Readonly<Record<string, AnyRouter>>;

// ---------- Vault-router placeholder (spec 060 T6, ADR 0011 Decision 3) ----------
//
// PRE-STABILISATION. The vault-router seam's real shape is owned by a LATER spec (062);
// until then it is a deliberate placeholder — minimal, experimental, and intentionally
// absent from the `/extension` entrypoint. (The auth-provider seam is no longer a
// placeholder: spec 061 T4 wired in the OWNED `AuthProvider`/`Principal` from `http/auth.ts`
// and `@librarian/core` — see the `authProvider` field below and {@link guardPublicAdmin}.)

/**
 * PLACEHOLDER vault-router slot (spec 060 T6, ADR 0011 `vaultRouter` seam).
 *
 * @experimental Shape owned by spec 062 (the real `VaultRouter`); will change — do
 * NOT depend on it. An OPAQUE marker: T6 delivers it to the store construction site
 * with no store behaviour of its own (062 gives it recall/write-routing meaning).
 * The brand field only stops this being the structurally-empty `{}` (which would
 * accept anything).
 */
export interface PluginVaultRouterPlaceholder {
  readonly __vaultRouterPlaceholder: true;
}

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
   * Procedures receive the existing `TrpcContext` (now carrying `principal` +
   * store; the `role` field is a deprecated derived mirror) as-is — the Principal
   * identity currency (ADR 0011 §4) is threaded in spec 061 T3.
   */
  readonly trpcRouters?: PluginTrpcRouters;
  /**
   * HTTP routes this plugin contributes (spec 060 T5, SC 6). Each {@link PluginRoute}
   * declares its `surface` ("public" | "internal") and its `auth` contract
   * ("agent" | "capture" | "none"); the factory ENFORCES that auth in the route-table
   * walk — with the same 401-challenge/403-scope helpers the core routes use — BEFORE
   * the handler runs, and serves the route only on its declared listener (it 404s on
   * the other). Matching is exact method + path (no prefix/wildcard — the `/trpc/*`
   * prefix stays a core-only capability).
   *
   * Three registrations are boot errors naming the plugin ({@link assertPluginRoutes},
   * called from the factory before the store opens, spec 060 SC 7): a route whose
   * path is `/trpc` or under `/trpc/` on EITHER surface (the prefix is core-reserved
   * on both listeners — publicly it would shadow the admin surface, ADR 0008 P1);
   * a method+path collision with a core route on the same surface; and a method+path
   * collision between two plugin routes on the same surface. Registrations add, they
   * never override. With no plugin supplying `routes` both listeners' tables are
   * byte-identical to today.
   */
  readonly routes?: readonly PluginRoute[];
  /**
   * PROVIDER seam (ADR 0011 Decision 3): the {@link AuthProvider} that answers "who is this
   * request?" per surface. Unlike the registration seams above, a provider REPLACES the OSS
   * default ({@link defaultAuthProvider}) rather than adding — so two registered plugins both
   * supplying `authProvider` is a boot error naming both ({@link resolveAuthProvider}).
   *
   * Spec 061 T4 made this LIVE: the factory wraps the supplied provider in the public-admin guard
   * ({@link guardPublicAdmin}) and that guarded reference becomes THE identity source on every
   * authenticated request path — public `/mcp`, the plugin-route auth walk, the core capture
   * routes (/transcript, /ingest), and the internal tRPC context (SC 7). The seam-facing type is
   * async-capable ({@link AuthProvider}), so a member-aware provider may resolve identity
   * remotely; the OSS default stays synchronous. With no plugin supplying it, every path defaults
   * to {@link defaultAuthProvider} and is byte-identical.
   */
  readonly authProvider?: AuthProvider;
  /**
   * PROVIDER seam (spec 060 T6, ADR 0011 Decision 3): the vault router that decides
   * "which shelves does this principal see, and where do writes land?". Like
   * `authProvider`, it REPLACES a default — two plugins supplying it is a boot error
   * naming both ({@link resolveVaultRouter}).
   *
   * PLACEHOLDER-typed (see {@link PluginVaultRouterPlaceholder}): the real
   * `VaultRouter`/`Shelf` are owned by spec 062, which consumes this slot at the store
   * construction site. At 060 it is pure delivery — no store behaviour changes.
   */
  readonly vaultRouter?: PluginVaultRouterPlaceholder;
  /**
   * The named opt-out amending ADR 0008's no-admin-on-public invariant (spec 060 SC 7,
   * ADR 0011 Consequences). The factory-owned {@link guardPublicAdmin} wrapper refuses
   * (403) a PUBLIC-surface request whose {@link authProvider}-resolved principal carries
   * the admin role — UNLESS the plugin that supplied that provider set this `true`. A
   * buggy provider therefore can't silently grant a network caller admin; a deliberate
   * one must say so in code. Only meaningful on the plugin that also supplies
   * `authProvider`; inert otherwise (nothing to guard). Default: admin-on-public is
   * refused.
   */
  readonly allowPublicAdmin?: boolean;
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

// ---------- Provider-seam resolution + the public-admin guard (spec 060 T6) ----------

/** The one admin role token the public-admin guard refuses on the public surface. */
const ADMIN_ROLE = "admin";

/**
 * Does this principal carry the admin role? The SINGLE place the "admin" token is
 * recognised for the public-admin guard. Comparison is NORMALISED — each role is
 * trimmed and case-folded before matching — so `["Admin"]`, `["ADMIN"]`, and
 * `["admin "]` are all recognised as admin and refused on the public surface, rather
 * than failing OPEN through an exact-string `includes`.
 *
 * Scope note (spec 061 owns the role vocabulary): 061's real Principal defines the role
 * names; this predicate only recognises the exact `admin` token (normalised). A
 * different role such as `"administrator"` is deliberately NOT admin here — a plugin
 * that mints its own admin-equivalent role under another name owns guarding it.
 */
function hasAdminRole(principal: Principal): boolean {
  return principal.roles.some((role) => role.trim().toLowerCase() === ADMIN_ROLE);
}

/**
 * Pick the single plugin filling a PROVIDER seam (ADR 0011 Decision 3: providers
 * REPLACE a default, they don't add). Returns the chosen plugin + its value, or
 * `undefined` when no plugin fills the seam. Throws (a construction-time boot error
 * naming BOTH plugins) when two plugins supply it — the factory calls this before
 * the store opens, so a double-provider config fails loudly with no side effects.
 */
function pickSingleProviderSeam<T>(
  plugins: readonly LibrarianPlugin[],
  seamName: string,
  select: (plugin: LibrarianPlugin) => T | undefined,
): { readonly plugin: LibrarianPlugin; readonly value: T } | undefined {
  let chosen: { readonly plugin: LibrarianPlugin; readonly value: T } | undefined;
  for (const plugin of plugins) {
    const value = select(plugin);
    if (value === undefined) continue;
    if (chosen !== undefined) {
      throw new Error(
        `Plugin "${plugin.name}" and plugin "${chosen.plugin.name}" both supply a ${seamName} ` +
          `provider. A provider seam REPLACES a default, it does not add (ADR 0011 Decision 3): ` +
          `only one plugin may fill it. Registration seams (tools, trpcRouters, routes) add — ` +
          `provider seams (authProvider, vaultRouter) replace.`,
      );
    }
    chosen = { plugin, value };
  }
  return chosen;
}

/** The auth provider a plugin set supplies, resolved with its guard opt-out. */
export interface ResolvedAuthProvider {
  readonly provider: AuthProvider;
  /** The supplying plugin's {@link LibrarianPlugin.allowPublicAdmin} (default false). */
  readonly allowPublicAdmin: boolean;
  /** The supplying plugin's name (for diagnostics). */
  readonly pluginName: string;
}

/**
 * Resolve the single supplied {@link LibrarianPlugin.authProvider} (or `undefined`),
 * carrying through the supplying plugin's {@link LibrarianPlugin.allowPublicAdmin}
 * opt-out. Throws (naming both) if two plugins supply one — a provider seam replaces,
 * it doesn't add (ADR 0011 Decision 3).
 */
export function resolveAuthProvider(
  plugins: readonly LibrarianPlugin[],
): ResolvedAuthProvider | undefined {
  const picked = pickSingleProviderSeam(plugins, "authProvider", (plugin) => plugin.authProvider);
  if (picked === undefined) return undefined;
  return {
    provider: picked.value,
    allowPublicAdmin: picked.plugin.allowPublicAdmin === true,
    pluginName: picked.plugin.name,
  };
}

/**
 * Resolve the single supplied {@link LibrarianPlugin.vaultRouter} (or `undefined`).
 * Throws (naming both) if two plugins supply one — a provider seam replaces, it
 * doesn't add (ADR 0011 Decision 3).
 */
export function resolveVaultRouter(
  plugins: readonly LibrarianPlugin[],
): PluginVaultRouterPlaceholder | undefined {
  return pickSingleProviderSeam(plugins, "vaultRouter", (plugin) => plugin.vaultRouter)?.value;
}

/**
 * A factory-owned {@link AuthProvider} wrapped by {@link guardPublicAdmin}. Same seam shape as a
 * raw provider — invoke for a request + surface (+ optional required scope) — so it drops into the
 * SAME auth call sites the OSS default occupies (spec 061 T4 consumes it there). Its result is the
 * same discriminated {@link AuthProviderResult}, with the no-admin-on-public refusal folded in: an
 * `{ ok: true }` admin-role principal on the public surface becomes `{ ok: false, status: 403 }`
 * unless the supplying plugin opted in.
 */
export interface GuardedAuthProvider {
  authenticate(
    req: IncomingMessage,
    surface: RouteSurface,
    requiredScope?: TokenScope,
  ): AuthProviderResult | Promise<AuthProviderResult>;
}

/**
 * Wrap a supplied {@link AuthProvider} in the FACTORY-OWNED public-admin guard (spec 060 SC 7 /
 * spec 061 T4, ADR 0011 Consequences — the amendment to ADR 0008's no-admin-on-public invariant).
 *
 * The guard forwards `req` / `surface` / `requiredScope` to the underlying provider (which owns the
 * 401/403 scope decision) and then, on the PUBLIC surface only, converts an `{ ok: true }` result
 * whose principal carries the admin role into `{ ok: false, status: 403 }` — UNLESS
 * `allowPublicAdmin` is set (the supplying plugin's named opt-out). So a buggy provider can't
 * silently grant a network caller admin, and a deliberate one must say so in code.
 *
 * SCOPE BACKSTOP (spec 061 review fix 3): the OSS default provider enforces `requiredScope` itself,
 * but a SUBSTITUTE provider might ignore it — leaving the D21 wall (`agent` reaches `/mcp`,
 * `capture` reaches `/ingest`) enforced by nobody. So for a NON-admin `{ ok: true }` principal with
 * a `requiredScope`, the guard requires `principal.scope` to match (an absent scope reads as
 * `agent`, matching the default provider and the `AuthResult` contract), else `{ ok: false, status:
 * 403 }`. Admin-role principals bypass the scope wall — admin outranks scope everywhere else too,
 * and this keeps the `allowPublicAdmin` (no-scope) passthrough intact. On the DEFAULT path the
 * provider already returned a scope-matched principal, so this re-check is a no-op — byte-identical.
 *
 * Every other result passes through UNCHANGED: any `{ ok: false }` refusal (401 or 403), a
 * scope-matching non-admin principal, ANY principal on the internal surface (trusted by isolation,
 * ADR 0008 P3 — internal callers pass no `requiredScope`), and — with the opt-out — an admin
 * principal on the public surface.
 *
 * This guarded reference is the ONLY provider reference the factory hands to the request paths
 * (060 review residual 1): the raw plugin provider never reaches a call site un-guarded — the
 * factory wraps it here and threads the wrapper, never `resolvedAuth.provider`.
 */
export function guardPublicAdmin(
  provider: AuthProvider,
  allowPublicAdmin: boolean,
): GuardedAuthProvider {
  return {
    async authenticate(req, surface, requiredScope) {
      const outcome = await provider.authenticate(req, surface, requiredScope);
      if (!outcome.ok) return outcome;
      if (surface === "public" && hasAdminRole(outcome.principal)) {
        // Admin on the public surface: refuse unless the plugin opted in; either way the
        // scope wall below does not apply to admins (admin outranks scope).
        return allowPublicAdmin ? outcome : { ok: false, status: 403 };
      }
      // Non-admin scope backstop: a substitute provider that ignored `requiredScope` is caught here.
      if (requiredScope !== undefined && (outcome.principal.scope ?? "agent") !== requiredScope) {
        return { ok: false, status: 403 };
      }
      return outcome;
    },
  };
}

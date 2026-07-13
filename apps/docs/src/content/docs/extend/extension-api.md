---
title: Extension API (plugins)
description: Add MCP tools, tRPC routers, and HTTP routes to your own Librarian build with a build-time plugin.
---

:::caution[Experimental]
The extension API is **experimental until spec 062 lands**. The
[ADR 0011](https://github.com/JimJafar/the-librarian/blob/main/docs/adr/0011-extension-seams.md)
semver promise for this surface starts at the 062 release — until then the shapes
here can change without a major version bump. Build against it, but pin your version
and expect to adjust.
:::

The Librarian composes from a single factory, `createLibrarianServer`, and accepts
**build-time plugins**. A plugin lets an in-process integrator — the private Teams
edition, or any third party — add MCP tools, tRPC routers, and HTTP routes, and (from
specs 061/062) supply the auth and vault-routing providers, **without forking or
touching upstream internals**.

## What a plugin is

A plugin is a plain **imported object** you pass to the factory. There is no dynamic
loading, no plugin directory, and no runtime discovery
([ADR 0011](https://github.com/JimJafar/the-librarian/blob/main/docs/adr/0011-extension-seams.md),
Decision 2): composition is a deliberate code change in whoever owns the entrypoint.
That keeps the security model trivial — a plugin is code you deliberately linked — and
the API surface small.

```ts
import { createLibrarianServer } from "@librarian/mcp-server";
import type { LibrarianPlugin } from "@librarian/mcp-server/extension";

const myPlugin: LibrarianPlugin = {
  name: "overlay",
  // ...seams below
};

const server = createLibrarianServer({
  // ...the env-derived options the bin normally resolves
  plugins: [myPlugin],
});
server.start();
```

The seam types come from the dedicated subpath entrypoint
**`@librarian/mcp-server/extension`**; the factory itself comes from the package root.

## The plugin envelope

```ts
interface LibrarianPlugin {
  name: string;                 // unique registry key + tRPC namespace
  tools?: ToolDefinition[];     // registration seam — MCP tools
  trpcRouters?: PluginTrpcRouters; // registration seam — admin tRPC routers
  routes?: PluginRoute[];       // registration seam — HTTP routes
  // authProvider — provider seam ("who is this request?"); its type is owned by
  //   spec 061 and is not published on this entrypoint yet (see Provider seams below).
  // vaultRouter  — provider seam ("which shelf?"); its type is owned by spec 062,
  //   likewise not yet published.
  allowPublicAdmin?: boolean;   // opt out of the no-admin-on-public guard
}
```

- **`name`** — the registry key. It is also the plugin's tRPC namespace, so it must be
  unique across the registered set and must not shadow a core router name.
- **`tools`**, **`trpcRouters`**, **`routes`** — the three **registration seams**.
  Registrations **add** to a registry (see the examples below).
- **`authProvider`**, **`vaultRouter`** — the two **provider seams**. Providers
  **replace** a default rather than add, so only one plugin may fill each. Their types
  are owned by later specs and are not published on this entrypoint yet — see
  [Provider seams](#provider-seams-specs-061062).
- **`allowPublicAdmin`** — the named opt-out to the public-admin guard, described under
  the provider seams.

## The three registration seams

### MCP tools

A plugin's `tools` **join** the same registry the core tools live in. Each lists in
`tools/list` with the **same role-filtering** the core tools get, dispatches through
`tools/call`, and receives the identical `(store, args, context)` handler contract.

```ts
import type { LibrarianPlugin, ToolDefinition } from "@librarian/mcp-server/extension";

const ping: ToolDefinition = {
  name: "overlay_ping",
  description: "Return pong.",
  inputSchema: { type: "object", properties: {} },
  handler: (_store, _args, _context) => ({
    content: [{ type: "text", text: "pong" }],
  }),
};

const plugin: LibrarianPlugin = { name: "overlay", tools: [ping] };
```

:::note[`adminOnly` tools are dead surface over HTTP today]
A tool may set `adminOnly: true`, but such a tool is currently **unreachable over HTTP
on either listener**: the public surface never resolves to the admin role, and the
internal listener serves no `/mcp`. Registering one is legal, but it only lists and
dispatches for an admin caller **off the network** (for example the stdio bin with
`LIBRARIAN_STDIO_ROLE=admin`) until a future spec gives the admin role an HTTP path.
:::

### tRPC routers

A plugin's `trpcRouters` **merge under the plugin's `name`** as a namespace, using the
same nesting the core's own feature routers use. A plugin
`{ name: "overlay", trpcRouters: { members: membersRouter } }` therefore serves its
procedures at `appRouter.overlay.members.*`, reachable on the **internal listener
only** (the admin tRPC surface). The dashboard's `AppRouter` contract is untouched —
it stays the core router type.

```ts
import type { LibrarianPlugin, PluginTrpcRouters } from "@librarian/mcp-server/extension";

const trpcRouters: PluginTrpcRouters = { members: membersRouter };
const plugin: LibrarianPlugin = { name: "overlay", trpcRouters };
```

### HTTP routes

A plugin's `routes` **append** to the per-surface route tables. Each route declares
its **`surface`** and its **`auth`** contract, and the factory enforces that auth in
the route walk — with the same 401/403 helpers the core routes use — **before** the
handler runs. See the [route contract](#the-route-surface--auth-contract) below.

```ts
import type { LibrarianPlugin, PluginRoute } from "@librarian/mcp-server/extension";

const whoami: PluginRoute = {
  path: "/overlay/whoami",
  method: "GET",
  surface: "public",
  auth: "agent",
  handler: (ctx) => {
    ctx.res.writeHead(200, { "content-type": "application/json" });
    ctx.res.end(JSON.stringify({ role: ctx.auth?.role ?? null }));
  },
};

const plugin: LibrarianPlugin = { name: "overlay", routes: [whoami] };
```

## The route surface + auth contract

Every plugin route declares two things, and the factory enforces both. The listener
split follows the Librarian's [authentication model](/deploy-and-operate/auth-and-secrets/).

- **`surface`** — `"public"` or `"internal"`. A route is served **only** on its
  declared listener and `404`s on the other.
- **`auth`** — `"agent"`, `"capture"`, or `"none"`. On the **public** surface the
  factory runs the same authentication the core routes run **before** invoking the
  handler, and hands the handler the resolved principal:
  - `"agent"` — the scope `/mcp` uses. A valid but wrong-scope capture token is `403`;
    a missing/invalid credential is `401` with the same `WWW-Authenticate: Bearer`
    challenge.
  - `"capture"` — the scope `/ingest` uses. An agent token is `403`.
  - `"none"` — no credential check; the handler receives a `null` auth result.

  On the **internal** surface the listener is trusted by isolation (the socket is the
  boundary), so an internal route runs behind the same origin gate the core `/trpc/*`
  route uses and resolves to the trusted admin principal regardless of the `auth`
  field.

:::caution[`auth` gates the credential check only]
The `auth` field decides **only** whether a credential is required before your handler
runs — it does **not** sandbox the handler. Every plugin handler runs with **full store
access**, so `auth: "none"` on a **public** route exposes whatever that handler does to
**unauthenticated network callers**. Review each public handler accordingly, and reach
for `auth: "none"` on the public surface only for genuinely open endpoints.
:::

## Collisions and refusals are loud

Registrations **add**; providers **replace**. Anything that would silently override is
a **construction-time boot error naming the offending plugin** — never a silent win:

- a duplicate plugin **`name`**;
- a plugin `name` that **shadows a core tRPC namespace**;
- a plugin **tool name** that collides with a core tool or another plugin's tool;
- a **public route under `/trpc`** (the admin tRPC surface is internal-only);
- a **route `method`+`path` collision** with a core route, or between two plugin
  routes, on the same surface;
- **two plugins filling the same provider seam** (`authProvider` or `vaultRouter`).

## Provider seams (specs 061/062)

The two provider seams **replace** a default answer rather than adding to a registry:

- **`authProvider`** — answers "who is this request?" per surface. Its real
  `Principal`/`AuthProvider` types are owned by **spec 061**.
- **`vaultRouter`** — answers "which shelves does this principal see, and where do
  writes land?". Its real `Shelf`/`VaultRouter` types are owned by **spec 062**.

Because those types are still being built, they are **not published on this entrypoint
yet** — they join `@librarian/mcp-server/extension` when their specs land. The slots
already exist on the envelope: at spec 060 a supplied provider is **accepted,
uniqueness-checked, and surfaced on the server handle's non-API `internals`**. Threading
it into live **auth** decisions lands with **spec 061**; threading the vault router into
the **store** lands with **spec 062**. Until then the slots are delivery-only.

### The public-admin guard and `allowPublicAdmin`

The Librarian's two-listener model keeps admin off the public port. Under a pluggable
auth provider that invariant becomes a **factory-enforced default**: if a supplied
provider, consulted for a **public-surface** request, resolves to a principal carrying
the **admin** role, the factory **refuses with `403`** — the handler never runs.

A plugin that genuinely intends admin over the public surface must say so in code, by
setting **`allowPublicAdmin: true`** on the plugin that supplies the provider. A buggy
provider therefore cannot silently grant a network caller admin; a deliberate one opts
out explicitly.

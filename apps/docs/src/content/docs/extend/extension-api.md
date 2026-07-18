---
title: Extension API (plugins)
description: Add MCP tools, tRPC routers, and HTTP routes to your own Librarian build with a build-time plugin.
---

:::note[Stable surface]
The extension API is **stable** as of the spec 062 release. It now carries the
[ADR 0011](https://github.com/JimJafar/the-librarian/blob/main/docs/adr/0011-extension-seams.md)
semver promise: a breaking change to any type or value published on
`@librarian/mcp-server/extension` is a **major version bump documented in the
[CHANGELOG](https://github.com/JimJafar/the-librarian/blob/main/CHANGELOG.md)**. Build
against it and pin your major. Everything **not** exported through this entrypoint stays
private and may change at any time — that small stable surface is the point.
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
  // authProvider — provider seam ("who is this request?"); its AuthProvider/Principal
  //   types are owned by spec 061 and are published on this entrypoint (see below).
  // vaultRouter  — provider seam ("which shelves?"); its VaultRouter/Shelf types are
  //   owned by spec 062 and are published on this entrypoint too (see below).
  // actorDisplayProvider — provider seam ("what display name accompanies this actor id?");
  //   its batch ActorDisplayProvider type is published on this entrypoint.
  allowPublicAdmin?: boolean;   // opt out of the no-admin-on-public guard
}
```

- **`name`** — the registry key. It is also the plugin's tRPC namespace, so it must be
  unique across the registered set and must not shadow a core router name.
- **`tools`**, **`trpcRouters`**, **`routes`** — the three **registration seams**.
  Registrations **add** to a registry (see the examples below).
- **`authProvider`**, **`vaultRouter`**, **`actorDisplayProvider`** — the three
  **provider seams**. Providers
  **replace** a default rather than add, so only one plugin may fill each. `authProvider`'s
  types (`AuthProvider`, `Principal`) are owned by **spec 061**; `vaultRouter`'s types
  (`VaultRouter`, `Shelf`, `ShelfOp`) are owned by **spec 062**. Both are **published on this
  entrypoint**, alongside spec 068's `ActorDisplayProvider` — see
  [Provider seams](#provider-seams-specs-061062068).
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

A plugin **HTTP** handler receives the resolved credential on `ctx.auth` as the **deprecated,
lossy `AuthResult`** (`{ role, agentId?, scope?, tokenId? }`) — its `agentId` is only the
cryptographic *binding* (unset for an unbound/sentinel caller), **not** the full identity. For the
complete `Principal` (its `actorId`, `roles`, and `attrs`), expose your surface as an **MCP tool**
or a **tRPC procedure** instead — both read `ctx.principal` directly.

## Collisions and refusals are loud

Registrations **add**; providers **replace**. Anything that would silently override is
a **construction-time boot error naming the offending plugin** — never a silent win:

- a duplicate plugin **`name`**;
- a plugin `name` that **shadows a core tRPC namespace**;
- a plugin **tool name** that collides with a core tool or another plugin's tool;
- a **route on `/trpc` — bare or prefixed — on either surface** (the prefix is
  core-reserved on both listeners: publicly it would shadow the admin tRPC
  surface, which is internal-only; internally it is the core admin API's own
  prefix);
- a **route `method`+`path` collision** with a core route, or between two plugin
  routes, on the same surface;
- **two plugins filling the same provider seam** (`authProvider`, `vaultRouter`, or
  `actorDisplayProvider`).

## Provider seams (specs 061/062/068)

The three provider seams **replace** a default answer rather than adding to a registry:

- **`authProvider`** — answers "who is this request?" per surface. Its real
  `AuthProvider`/`Principal` types are owned by **spec 061** and are **published on this
  entrypoint now** (`AuthProvider`, `AuthProviderResult`, `SyncAuthProvider`, `Principal`).
- **`vaultRouter`** — answers "which shelves does this principal see, and where do
  writes land?". Its `Shelf`/`ShelfOp`/`VaultRouter` types (and the two typed write
  errors, `ShelfNotWritableError` / `ShelfNotInWriteSetError`) are owned by **spec 062**
  and are **published on this entrypoint** — see [Writing a vault router](#writing-a-vault-router).
- **`actorDisplayProvider`** — answers "what human-readable display accompanies these
  actor ids?". Its `ActorDisplayProvider` type is owned by **spec 068** and published
  on this entrypoint — see [Writing an actor display provider](#writing-an-actor-display-provider).

The slots exist on the envelope from spec 060, where a supplied provider is **accepted,
uniqueness-checked, and surfaced on the server handle's non-API `internals`**. As of spec
061 the `authProvider` seam is **live**, and as of spec 062 the `vaultRouter` seam is **live**
too: a supplied router is threaded into the **store**, and recall, reference search, writes,
grooming, and the capture pipelines all resolve through it. With no plugin router the store
uses the OSS `defaultVaultRouter` (one writable shelf at the vault root) and behaviour is
**byte-identical** to a single-vault install.

### Writing an actor display provider

An `ActorDisplayProvider` synchronously resolves a **batch** of stable actor ids. It receives
only ids already present in the caller's scoped response, exactly once per response, and returns
a `ReadonlyMap` so untrusted ids such as `"constructor"` are data rather than prototype keys.
A missing map key means "show the id"; plugins that need I/O preload their directory.

```ts
import type {
  ActorDisplayProvider,
  LibrarianPlugin,
} from "@librarian/mcp-server/extension";

const actorDisplayProvider: ActorDisplayProvider = {
  resolveActorDisplays(ids: readonly string[]): ReadonlyMap<string, string> {
    return new Map(ids.flatMap((id) => {
      const display = memberDirectory.get(id);
      return display === undefined ? [] : [[id, display]];
    }));
  },
};

const plugin: LibrarianPlugin = { name: "overlay", actorDisplayProvider };
```

Before the wire, the server strips C0 controls, DEL, Unicode line/paragraph separators,
and bidi controls/isolates, caps each name at 64 safe Unicode code points, and omits names
that become empty. Returned keys outside the original scoped id batch are ignored. A
failure while calling, consuming, or sanitising a resolver result fails soft to raw ids.

Names never replace ids:

- `activity.auditExport` adds `actorDisplays?: Readonly<Record<string, string>>` to the
  **page envelope**. Its strict `AuditEvent` rows remain unchanged. The wire uses a JSON
  record because this tRPC surface has no transformer; consumers must use
  `Object.hasOwn(page.actorDisplays, actorId)` for untrusted keys.
- `memories.proposalsForReview` adds `actorDisplay?: string` beside each row whose nested
  `proposal.agent_id` resolved. The dashboard renders the name and keeps the id in a
  tooltip.

With no provider, neither optional field is present and the existing payloads and
dashboard DOM remain byte-identical.

### Writing an auth provider

An `AuthProvider` has one method — `authenticate(req, surface, requiredScope?)` — returning
an `AuthProviderResult`: either `{ ok: true, principal }` or a `{ ok: false, status: 401 | 403 }`
refusal (the discriminated shape exists because a bare `Principal | null` cannot express the
wire contract's wrong-scope-`403` vs no-credential-`401` distinction). The signature is
**async-capable** — return an `AuthProviderResult` **or** a `Promise` of one, so a member-aware
provider may resolve identity over the network. The OSS default is synchronous
(`SyncAuthProvider`), and a sync result is assignable to the async seam, so both share every
call site.

The **`Principal`** you return is the one identity currency threaded from the listener to the
store write. Its contract:

- **`actorId`** — always present and **non-empty**. It is the resolved actor recorded in a
  memory's frontmatter `agent_id`. An empty string is a **contract violation**, not a legal
  "anonymous" value — for an authenticated-but-unnamed caller, return a **sentinel** id (the
  OSS default uses `env-token-agent` for the shared env single-token path and `local-agent`
  for the localhost no-auth bypass).
- **`boundActorId`** — set **only** when a credential *cryptographically binds* the identity
  (a per-agent token, a DB-minted `lib.<id>.…` token). It is what the impersonation guard
  consumes: if a request body claims an `agent_id` that disagrees with a `boundActorId`, the
  call is **refused**. So a sentinel/fallback actor must **never** be a `boundActorId` — that
  would make every self-identifying caller collide with the guard. Leave it unset for unbound
  callers; a body-supplied `agent_id` then wins for attribution, exactly as today.
- **`roles`** — an array of strings; **authorisation reads `roles`, not `kind`**. Put the
  **exact lowercase string `"admin"`** here for an admin caller: every *admission* check (the
  tRPC `adminProcedure`, a tool's `adminOnly`) matches `"admin"` exactly, so a case variant like
  `["Admin"]` is **not** admitted — it is `403`'d on the public surface and `401`'d by an internal
  admin procedure. The **public-admin guard** (below) deliberately normalises (trim + case-fold)
  only to **fail closed**: it recognises `"Admin"` / `" ADMIN "` as admin so it can **refuse** them
  on the public surface — it never *grants* on a variant. So a provider **must emit lowercase
  `"admin"`**. `kind` is an **open** string union
  (`"admin" | "agent" | "system" | (string & {})`) for your own labelling — introduce
  `"member"` or `"curator"` freely; core never branches on it.
- **`attrs`** — a free-form, read-only `Record<string, string>`, **opaque to core** (it is
  never read by the OSS pipeline). A member-aware provider carries `memberId` here for its own
  downstream tools; the flat-string type keeps the blast radius small.
- **`scope`** / **`tokenId`** — optional, mirroring the token fields. `scope` gates the public
  D21 wall (`agent` reaches `/mcp`, `capture` reaches `/ingest`): your provider **must honour the
  `requiredScope`** argument — refuse a wrong-scope credential with `403`. As belt-and-braces, the
  factory's **public-admin guard also backstops it**: for a **non-admin** principal on a scoped
  public route it requires `principal.scope` to equal the required scope (an absent scope reads as
  `agent`), else `403` — so set `scope` correctly on every principal. Admin-role principals bypass
  the scope wall (admin outranks scope).

```ts
import type { IncomingMessage } from "node:http";
import type { AuthProvider, Principal } from "@librarian/mcp-server/extension";

const memberAuth: AuthProvider = {
  async authenticate(req: IncomingMessage, surface, requiredScope) {
    // The internal listener is trusted by isolation — grant the admin actor.
    if (surface === "internal") {
      return { ok: true, principal: { kind: "admin", actorId: "dashboard-admin", roles: ["admin"] } };
    }
    // Resolve the member from your own credential store (async is allowed here).
    const member = await lookupMember(req.headers.authorization);
    if (!member) return { ok: false, status: 401 }; // no/invalid credential
    if (requiredScope === "capture") return { ok: false, status: 403 }; // wrong door

    const principal: Principal = {
      kind: "member",                 // your own label; core reads `roles`, not `kind`
      actorId: `member-${member.id}`, // non-empty; lands in frontmatter `agent_id`
      boundActorId: `member-${member.id}`, // a real binding → the impersonation guard honours it
      roles: ["agent"],
      scope: "agent",
      attrs: { memberId: member.id }, // free-form; opaque to core
    };
    return { ok: true, principal };
  },
};
```

### The public-admin guard and `allowPublicAdmin`

The Librarian's two-listener model keeps admin off the public port. Under a pluggable
auth provider that invariant becomes a **factory-enforced default**: if a supplied
provider, consulted for a **public-surface** request, resolves to a principal carrying
the **admin** role, the factory **refuses with `403`** — the handler never runs.

A plugin that genuinely intends admin over the public surface must say so in code, by
setting **`allowPublicAdmin: true`** on the plugin that supplies the provider. A buggy
provider therefore cannot silently grant a network caller admin; a deliberate one opts
out explicitly.

### Writing a vault router

A **`VaultRouter`** answers, per [`Principal`](#writing-an-auth-provider): **which shelves
does it see** (ordered, first = highest precedence) for a given operation, and **where do
its own writes land**. A **shelf** is a rooted **prefix** inside the *one* vault git repo
(ADR 0011 Decision 5 — subtrees, not a second repo, so one history, one backup, one export,
and promotion stays a `git mv`). The OSS default maps every principal to a single writable
shelf at the vault root; a member-aware router gives each member a merged view — a personal
shelf plus a read-only team shelf, provenance-labelled.

```ts
interface Shelf {
  id: string;         // stable, non-empty; recall labels every hit with it
  prefix: string;     // vault-relative, e.g. "members/x/" — "" is the vault root
  writable: boolean;  // gates principal-attributed writes (a read-only team shelf is false)
  label?: string;     // optional, non-blank display text; ids remain available because labels rename
}

type ShelfOp = "recall" | "search" | "write" | "groom";

interface VaultRouter {
  shelves(principal: Principal, op: ShelfOp): readonly Shelf[]; // ordered, first = highest precedence
  writeTarget(principal: Principal): Shelf;                     // where this principal's new material lands
}
```

**Prefix rules (enforced — a violation throws the first time the router is used for a
principal, naming the offending shelf):**

- **relative, forward-slash, no leading slash** or drive letter;
- a **trailing slash** is required on every non-empty prefix (`members/x/`); the **empty
  prefix** `""` is the vault root and is exempt from the syntax rules;
- **NFC-normalised** — a non-NFC prefix is refused, never silently rewritten;
- no empty / `.` / `..` segments;
- the first segment must **not shadow a canonical name** (`memories`, `handoffs`,
  `references`, `.curator`, `inbox`, `primer.md`, `.index`, `.git` are reserved);
- prefixes in a set must be **disjoint** — no duplicates and no nesting (`team/` and
  `team/sub/` may not coexist; the root `""` nests everything, so it can't sit beside
  another shelf). Disjointness is checked **case-insensitively** (`Team/` and `team/` are the
  same directory on a case-insensitive filesystem, so they collide);
- a prefix is capped at **two segments** — `members/x/` is the deepest shape (`members/x/y/` is
  refused). This keeps a backed-up shelf tree restorable: the restore-staging guard scans to the
  same depth, so widening the cap is a deliberate change that must move the restore scan with it;
- the **id** must be printable with no `]` or newline (it renders inside a recall provenance
  token, `[<label> (<id>)]`); `/` is legal, so ids like `members/x` are fine;
- a supplied **label must contain non-whitespace text**; blank display chrome is refused
  rather than allowed to hide the stable id;
- the ids of **writable** shelves must be **unique** (so `writeTarget` names one shelf
  unambiguously); a non-writable shelf may reuse an id.

**The shelf layout rule.** Each non-empty prefix contains the **canonical layout beneath
it** — `<prefix>memories/`, `<prefix>handoffs/`, `<prefix>references/`, `<prefix>inbox/`,
`<prefix>.curator/` — with the path-discipline and visibility rules applied **shelf-relative**
(so `members/x/inbox` is hidden exactly as a root `inbox` is, and `members/x/.curator` stays
visible). The **singletons stay vault-root**: `primer.md` and the `.index`/embedding caches
are vault-singular, served and kept as today. Sidecars and the git repo remain singular; every
write still flows through the one commit path.

**`writeTarget` semantics + the write-set agreement rule.** `writeTarget(principal)` governs
**principal-attributed writes only** — where a `remember` / `store_handoff` / `/ingest`
reference lands. It does **not** drive the system pipelines. Two rules are enforced at write
time:

- the target must be **`writable`** — a `writeTarget` that returns a read-only shelf throws
  **`ShelfNotWritableError`** (spec 062 SC 6);
- the target must be a **member of `shelves(principal, "write")`** — otherwise "where writes
  land" and "what may be written" disagree, and it throws **`ShelfNotInWriteSetError`**.

Both are published error classes: the OSS MCP and tRPC boundaries already catch them and
return a **clean error** (a JSON-RPC error for `/mcp`, never a 500 crash); catch them yourself
if your plugin surfaces its own write UX.

**What agents see: merged, labelled recall.** For a `recall` (or `search_references`) the store
consults **every shelf in `shelves(principal, "recall")` in router order**, recalls each through
its own per-shelf index, and merges them by a **per-shelf rank interleave**: strict alternation
(shelf A's #1, then B's #1, then A's #2, …), router-order priority on equal rank, **deduped by
memory id** with the earliest (highest-precedence) shelf winning, and the caller's `limit`
applied **after** the merge. Scores are **not** compared across shelves — each shelf's index is
built independently and its hybrid scores are rank reciprocals, not comparable across indexes,
which is exactly why the merge interleaves by rank rather than sorting by score. Every merged hit
is **tagged with its shelf** and the MCP text leads each line with a provenance token —
`[<label> (<id>)]` when the shelf has a label, `[<id>]` otherwise — but **only** when the
materialised set has more than one shelf. Under the default (single-shelf) router the tokens are
absent and the output is byte-identical.

**System pipelines are scoped, not routed — and not writability-gated.** Grooming and inbox
draining do **not** consult `writeTarget`, and they are **not** gated by `writable`. `writable`
gates *principal-attributed* writes only; grooming and intake are **system** pipelines scoped to
the shelf they are processing (spec 062 §4), so a **read-only team shelf still grooms** and drains
its inbox, its writes landing under that shelf. Grooming iterates `shelves(system, "groom")` and
runs each pass against a **shelf-scoped store handle** whose reads, proposals, and writes are
confined to that shelf; the intake sweep drains **every groom shelf's inbox**, each within its own
scope (still attributed to the system consolidator). So the **groom set drives both grooming and
inbox draining** — a router that routes captures onto a shelf must also **groom** that shelf, or its
inbox never drains. Only principal-attributed *capture* uses `writeTarget`.

**The write gate is per call, not baked.** `writable` is evaluated **per call** from the `Shelf`
you hand `shelves` / `writeTarget` — never memoized. The store memoizes the expensive per-prefix
core (scoped vault, raw stores, cached index) but derives the write gate freshly each time, so the
same prefix honestly serves a writable view (a groom, a `writeTarget` write) and a read-only view (a
member's read-only recall of a team shelf) without one order neutering the other. Returning the same
prefix with different `writable` for different ops is therefore safe and expected.

**Handoffs and flags route across the principal's shelves.** `store_handoff` lands on
`writeTarget`, but `list_handoffs`, `claim_handoff`, and `flag_memory` route across the principal's
**`recall`** shelves (not just the vault root), so a member can list/claim a handoff stored under
their own shelf and flag a memory recalled from any of their shelves. A `claim`/`flag` is a
principal-attributed **mutation**, so it **respects the shelf's `writable`**: flagging or claiming on
a **read-only** shelf raises `ShelfNotWritableError` (surfaced as a clean error) — the honest Teams
answer, since a member may not mutate a read-only team shelf's material. Under the default router
this is a single writable shelf, byte-identical to before.

**A worked member router** — the Teams shape: a writable personal shelf plus a read-only,
labelled team shelf. Sarah recalls across both and writes to her own; a member routed to the
read-only team shelf for writes is refused.

```ts
import type { Principal, Shelf, ShelfOp, VaultRouter } from "@librarian/mcp-server/extension";

const personal: Shelf = { id: "members/x", prefix: "members/x/", writable: true, label: "Sarah's shelf" };
const team: Shelf = { id: "team", prefix: "team/", writable: false, label: "Team library" };

const memberRouter: VaultRouter = {
  shelves(principal: Principal, op: ShelfOp): readonly Shelf[] {
    // recall / search / groom see [personal, team]; writes see only the writable personal shelf.
    return op === "write" ? [personal] : [personal, team];
  },
  writeTarget(_principal: Principal): Shelf {
    return personal; // Sarah's new memories land under members/x/memories/…
  },
};

const plugin: LibrarianPlugin = { name: "overlay", vaultRouter: memberRouter };
```

Sarah's `remember` lands under `members/x/memories/…` attributed to her actor; her `recall`
returns hits from both shelves, each labelled (`[Sarah's shelf (members/x)]`,
`[Team library (team)]`), interleaved by the merge rule. A router whose `writeTarget` returns the
read-only `team` shelf for some principal makes that principal's `remember` fail with
`ShelfNotWritableError`, surfaced as a clean error — never a crash. Because a shelf is a prefix in
the one repo, a **backup + restore round-trip** carries every shelf's contents together, and the
restore-staging guard recognises the shelf-prefixed layout.

**Restore vault-detection — accepted shapes.** The restore-staging guard ("does this clone look like
a Librarian vault at all?") accepts either a canonical entry
(`memories`/`inbox`/`references`/`handoffs`) **directly at the vault root** (the OSS single-shelf
vault), **or** the canonical layout beneath a **shelf prefix of up to two segments** (`team/`,
`members/x/`) — where the prefix dir carries a `memories/` dir, or two of the four canonical dirs, or
one canonical dir plus a `.curator/` or `primer.md` sibling. Every prefix segment must be shelf-legal,
and the scan is bounded to the same two-segment depth the prefix rules cap at, so any shelf tree you
can back up is restorable.

## The dashboard identity assertion (spec 065)

The dashboard reaches the server over the **trusted internal tRPC listener** — admin with
no bearer, because that listener is reachable only over loopback / the internal Docker
network ([ADR 0008](https://github.com/JimJafar/the-librarian/blob/main/docs/adr/0008-auth-secrets-model.md) P3).
From spec 065 the dashboard also **asserts, on every server call, who the call is on
behalf of** — a signed-in user, or explicitly *nobody* — in one request header. The header
is a **scoping assertion, not a credential**: the dashboard process is already trusted, so
the assertion is that trusted process *voluntarily narrowing* a request to its user — a
privilege drop, like `sudo -u`. The OSS default provider **ignores it** (admin-by-isolation,
byte-identical); a member-aware `authProvider` uses it to resolve member principals.

### The contract

One header, **`x-librarian-dashboard-user`**. Its value is either the literal poison
marker **`invalid`**, or `base64url(UTF-8 JSON)` of exactly one of two **closed** shapes:

- `{ "anon": true }` — an **anonymous assertion**: a browser-origin request with no session;
- `{ "provider": string, "sub": string, "email"?: string, "name"?: string }` — a
  **user assertion**. `provider` + `sub` are both required: `sub` alone is not unique
  across providers (GitHub and Google both mint numeric ids). The credentials (password)
  owner's `sub` is the pinned constant **`"owner"`** — the typed username is mutable
  config, not a stable subject.

Encoded size is capped at 4&nbsp;KB, enforced by the **setter**: claims that will not
encode within the cap become the poison marker — never an omitted header, never an
oversize value. base64url, not raw JSON, because HTTP header values are
ByteString-constrained — a non-latin1 display name must not crash the hop.

Read it with the published helper — the parser **is** the security boundary:

```ts
import {
  DASHBOARD_USER_HEADER,
  DASHBOARD_USER_POISON,
  readDashboardUser,
  type DashboardAssertion,
} from "@librarian/mcp-server/extension";

const assertion: DashboardAssertion = readDashboardUser(req);
// { kind: "absent" } | { kind: "invalid" } | { kind: "anonymous" }
//   | { kind: "user", user: { provider, sub, email?, name? } }
```

`readDashboardUser` never throws. Everything that is not *positively* one of the two claim
shapes — malformed base64, malformed JSON, oversize, non-object payloads, duplicated
headers, a shape mix, or an otherwise-valid shape carrying **any** undeclared key — is
`{ kind: "invalid" }`. Absence and badness are **different outcomes** because they route to
opposite trust results below; a helper that collapsed both to `null` would let an oversize
or corrupt assertion resolve to admin.

### The assertion trust model

A member-aware provider on the internal surface resolves:

| assertion | resolution |
|---|---|
| absent | the admin-by-isolation principal (machine calls: the bare-client bootstrap traffic — the auth-config fetch, `verifyPassword`, the reset redemption — middleware's enforcement read, and module-init execution) |
| `invalid` (poison) or undecodable | **refusal** |
| `{anon:true}` | **refusal** (or a public-only principal — provider's choice; never admin) |
| user assertion, unknown subject | **refusal** |
| user assertion, known subject | that mapping's principal |

Consequences, stated plainly:

- **A member-aware tenant with enforcement `"open"` fails LOUDLY on all three call legs.**
  Proxied browser queries carry `{anon:true}`, and sessionless RSC renders and server
  actions also carry `{anon:true}` (they are browser-triggered work), so every leg is
  refused and the dashboard is visibly unusable rather than silently vault-wide — the
  anonymous assertion converts that misconfiguration from a leak into an outage.
- **The absent row is honestly fail-open, by inheritance from ADR 0008 P3** — it *is*
  today's trust, unchanged. The anonymous and poison rows shrink the absent class to the
  genuine machine contexts (the bare bootstrap client, and no-request-scope execution).
  The residual — a future dashboard code path that forgets the identity client and so
  speaks with machine trust — is accepted and is in the same trust class as a
  session-handling bug in today's dashboard.
- **"absent → refuse" is deployment-breaking.** The sign-in bootstrap (config fetch,
  password verification) and the break-glass password reset are sessionless *by design*;
  their credentials are out-of-band (process trust, the password being verified, the
  store-validated one-time link token). A provider that refuses absent assertions kills
  sign-in and account recovery in every member-aware deployment.
- 065 **does not weaken ADR 0008 P3**: anything that can reach the internal listener could
  already be admin today. The flip side is unchanged too — the internal listener must stay
  unpublished, same as today.

### `memberProcedure` and the admin-superset rule

`trpc/trpc.ts` has a second procedure tier, **`memberProcedure`**, admitting the `member`
or `admin` role. Two rules govern it:

- **Moving a procedure to the member tier is a deliberate per-procedure act that must
  arrive with principal-scoping of that procedure's reads in the same change.** A
  member-reachable procedure still calling vault-global store surfaces would reopen the
  confidentiality hole the tier exists to close. Everything not deliberately moved stays
  `adminProcedure`-gated, so a member reaches nothing by default (fail-closed).
- **Admin is a procedure-tier superset**: `roles.includes("admin")` passes every
  `adminProcedure`, and `member` never narrows it. Principal-aware data paths still consult
  the router's shelf set, so an admin can be corpus-scoped even though it can enter every
  admin procedure. Mint `admin` only for principals entitled to those operations within
  their routed corpus; finer capability policy is the provider's business (it mints
  `roles` and routes shelves).

`health.ping` / `health.info` stay `publicProcedure` by design — the dashboard's pre-auth
chrome depends on them. `vault.moveAccess` is also public, but deliberately returns only
the caller's resolved `{ canDirectMove }` capability bit; it does not disclose a role,
principal, shelf, or vault datum.

### The scoped slice (what 065 moved)

Exactly six procedures — the memories browse surface, its shelf inventory, and the
member proposal boundary — use
`memberProcedure` with
principal-scoped store surfaces:

- **`memories.list`** → `store.listMemoriesForPrincipal(principal, filters)`: per-shelf
  rows enumerated **uncapped** inside core, merged by the requested sort key
  (`created_at | updated_at | title`; default `updated_at` desc) with a deterministic
  tie-break (router shelf order, then memory id), `offset`/`limit` applied **after** the
  merge. Duplicate logical ids are removed before sorting and paging, with the first
  (highest-precedence) shelf winning, so `total` is the unique filtered row count. Each
  merged row carries `shelfId` (+ `shelfLabel`) **only** when the materialised shelf set
  has length&nbsp;>&nbsp;1; with the default router the call delegates to the main
  handle — byte-identical.
- **`memories.distinctValues`** → the union over the `"recall"` shelf set.
- **`memories.recall`** → `store.recallForPrincipal` (062's merged recall, labels and all).
- **`vault.shelves`** → `store.shelvesForPrincipal(principal)`: the deduplicated
  `"recall"` shelf inventory. Shared ids merge in router order (the first label wins and
  `writable` is true when any bearer is writable); prefixes never cross the wire.
- **`vault.searchReferences`** → `store.searchReferencesForPrincipal` (062's `"search"`
  op); its `searched` denominator is the principal-scoped reference count.
- **`memories.proposeMove`** → creates a `proposed_action: "move"` proposal on the
  principal's canonical write target. The source must resolve through the principal's
  recall shelves, the destination must be one of those shelves, and the write target's
  duplicate scan is scoped to that target. A member may therefore propose a move into a
  visible read-only shelf, but cannot write the destination directly.

The shelf set for memory visibility is `router.shelves(principal, "recall")` — no new
`ShelfOp` was added. A new core primitive, `store.getMemoryForPrincipal(principal, id)`,
resolves an id through the same shelf set and returns `null` for an off-shelf id —
indistinguishable from absent (no existence oracle). The proposal review and execution
paths use this same scoped resolution rule. A principal whose materialised shelf set is
**empty** gets the empty envelope / empty union / `null` — never a throw.
`memories.proposeMove` is the first member-tier write boundary, but it can only create a
review proposal on the caller's own write target. Direct movement (`memories.move`),
applying or rejecting proposals, and every other state-changing procedure (including
`memories.create`) stay admin-gated.

`memories.list` accepts an optional `shelf` id. Core first restricts the principal's
materialised `"recall"` set to matching shelves and only then enumerates rows, so an
unknown or off-set id returns the same empty envelope and cannot serve as a shelf
existence oracle. Shelf ids and labels appear on memory and reference rows only when the
materialised set has more than one shelf; the single-shelf default remains byte-compatible.

### Move and proposal-moderation boundaries

`moveMemoryForPrincipal(principal, id, destinationShelfId)` resolves both the memory and
destination through the principal's validated `"recall"` set and requires writable source
and destination shelves. It preserves the filename and bytes, refuses an occupied
destination, rejects symbolic-link traversal and non-regular source files, and claims the
destination atomically before removing the source. A failed Git commit restores the source,
removes the destination, resets both paths in the index, and invalidates both shelf indexes.
Git receives literal pathspecs, so wildcard-shaped filenames cannot widen a move commit.

Proposal review is scoped the same way: an off-shelf proposal or target is
indistinguishable from an absent one, and previews never resolve across that boundary.
Approval, rejection, and resolution use narrow admin-only core methods. Those methods may
consume a **visible proposal document** on a shelf reported as read-only—moderation must
still work for member-submitted proposals—but they do not bypass writability for the
proposal's target or for arbitrary shelf content.

### The vaultRouter / authProvider coupling

A scoping `vaultRouter` **without** an `authProvider` that mints member principals leaves
every dashboard request admin-with-full-vault: the default provider ignores the assertion,
resolves admin by isolation, and the router's member arms never fire. The combination is
**legitimate** (a router may scope by agent principals from public-surface tokens, with no
dashboard auth involved), so the factory does not refuse it at boot — but if you mean to
scope the *dashboard*, you must fill **both** seams.

### Out of scope in 065 (honest list)

- **Member sign-in mechanics** — how a Teams member *gets* a session (control-plane OIDC,
  or a trusted-header auth mode) is its own spec; the OSS dashboard stays single-owner.
- **The rest of the dashboard surface** (handoffs, vault explorer/editor, flagged,
  aggregates/analytics, tokens, `memories.related`) — mechanical repetitions of the slice
  pattern, deferred. Until then a member hitting an unopened surface gets that page's
  **own error handling** — there is no global `error.tsx` boundary in the dashboard, so
  member UX on unopened surfaces is "per-page error state", not a styled 401 page.
- **Attributing the OSS owner's dashboard writes as themselves** rather than
  `dashboard-admin` — byte-identity wins for now.
- **A refusal log** ("who *attempted* what").
- **Cryptographic binding of the assertion** — the isolation-trust argument is the same
  one that grants admin-with-no-bearer today; a signed variant remains additive.

## The audit export (spec 064)

The **typed audit export** is the read half of the attribution substrate: it turns the
vault's git history into a stream of typed `AuditEvent`s answering *"who **successfully**
changed what, when, on which shelf"* — without a consumer ever parsing git. It is published
on the stable entrypoint, so a plugin (a Teams overlay, a compliance reviewer's tool) builds
against it and pins its major.

### The published record

```ts
import type { AuditEvent, AuditAction } from "@librarian/mcp-server/extension";
import { AuditEventSchema, AuditSourceError } from "@librarian/mcp-server/extension";
```

`AuditEvent` is:

```ts
{
  schemaVersion: 1;
  commit: string;            // the commit hash
  at: string;                // author date, ISO-8601
  actor: string | null;      // the Librarian-Actor trailer, or null (see below)
  channel: "agent" | "curator" | "admin" | "system" | "other";
  action: AuditAction;       // a CLOSED union — one member per commit-subject verb
  subjectId: string | null;  // the object's opaque id (memory/handoff/inbox), or null
  shelves: readonly string[];// the in-scope shelf ids this event touched
  paths?: readonly string[]; // ADMIN-ONLY (a filename encodes a memory title)
  renames?: readonly { from: string | null; to: string | null }[]; // ADMIN-ONLY
  diff?: { files: readonly { path; diff; truncated }[] };           // ADMIN-ONLY, opt-in
  revertedTo?: string;       // a whole-vault rollback's target commit
}
```

- **`AuditAction` is a closed, permanent union.** One member per commit-subject verb (the T1
  vocabulary) plus the synthetic export-only members (`vault.change`, `shelf.departure`,
  `shelf.arrival`, `other`). It is never a wildcard — a plugin can exhaustively `switch` on
  it, and **adding a member is a major version bump**.
- **`memory.move` is a next-major candidate.** Until that major release, move commits map
  to `other`; cross-shelf moves still emit the typed, shelf-scoped
  `shelf.departure`/`shelf.arrival` pair, so current consumers remain exhaustive without
  losing shelf-level movement.
- **`actor` is an honest null.** It is `null` for an untrailered commit (pre-064 history, a
  system sweep, an anonymous write) **and** for a commit carrying ≠ 1 `Librarian-Actor`
  trailer — a forged or duplicated trailer is never believed. A false name is worse than an
  honest null.
- **`paths` / `renames` / `diff` are admin-only.** A memory's filename encodes its title, so
  a non-admin caller receives only `actor` + `action` + `subjectId` + `shelves` + `at`.

`AuditEventSchema` (a zod value) validates the wire shape; `AuditSourceError` (a value, so a
plugin `instanceof`-checks it) signals a broken `.git`, distinct from `AuditCursorError` (a
stale/unknown pagination cursor — a client error, never a 500).

### The procedure

`activity.auditExport` (the **member** tier) is a thin pass-through of the caller principal to
`store.exportAudit`. The store does **all** gating from the principal's role and recall
shelves, so a member gets the redacted slice and an admin the full record — both scoped to
`shelves(principal, "recall")`. Pagination is **commit-addressed**: `before` is a commit hash,
the page is 100 commits, and `nextCursor` is the **oldest commit scanned** (so a page that
filters to zero events still advances — a shelf-scoped client never dead-ends). `hasMore`
counts commits, not events.

### Performance (spec 064 SC 13)

Every `git-history` call is a synchronous fork blocking the event loop, so the page cap is
measured, not assumed. On the build machine (1,000 single-file commits):

- **Metadata export** (10 pages × 100 commits, no diffs): **~1.1 s total** — ~110 ms per
  100-commit page, one `git log` fork each.
- **Diff export** (one 100-commit page, `includeDiff`): **~1.9 s** — a `git show` fork *per
  commit* dominates (~19 ms/commit).

The **100-commit page** (half the 200-commit activity-feed clamp) keeps even the diff case
bounded to ~2 s; a 200-commit diff page would be ~4 s, and larger pages would block the event
loop unacceptably. Diffs are therefore opt-in and admin-only, and the page is never raised
above 100.

### Out of scope in 064 — the honesty list

The claim is **"who *successfully* changed what"**, never "who did what". These are the gaps,
named rather than hidden:

- **Reads.** Nothing records recall/search/get. The export cannot answer "who read what".
- **Refused writes.** `ShelfNotWritableError` / `ShelfNotInWriteSetError` and every 403
  produce no commit and no record. **Denied-access evidence is a first-class SOC 2 / ISO
  27001 requirement — so the claim is "who *successfully* changed what", never "who did
  what"** until a refusal log exists (candidate 066).
- **No-op mutations.** With the index-scoped guard, a mutation that changes nothing commits
  nothing and leaves no trace.
- **Non-vault admin actions** — tokens, settings, backup/LLM config land in `settings.json`,
  uncommitted and unattributed.
- **CLI writes are unattributed.** `SYSTEM_ACTOR_IDS.cli` exists but has **zero producers** —
  `createCliStore` builds a store with no principal, so CLI writes fall through to
  `DEFAULT_AGENT_ID` and export `actor: null`. Giving the CLI a principal is out of scope here
  (a small follow-on).
- **The inbox item lifecycle** (claim / complete / drain file moves) is captured by the
  sweep's mop-up commit, so those *file moves* are attributed to `system-consolidator` in
  aggregate rather than per-item. The memories the sweep writes ARE individually attributed
  (they go through `createMemory`/`updateMemory` with an actor).
- **Concurrency, in both directions — only a repo lock truly fixes it.** With no lock: (i) a
  `commitPaths` write that races a `backup: snapshot` can have its bytes committed by the
  sweep instead — **untrailered**; and (ii) `git commit -- <paths>` is `--only` mode, so it
  commits the **working tree** at commit time, not the index — a human's concurrent save to
  *the same file* is therefore committed **under the actor's trailer**. Path-scoping narrows
  both windows to same-file collisions, but does not close them. A repo lock is a candidate
  follow-on; it is named here, not hidden.
- **Subscriptions / webhooks / event bus** — none exists; poll-based export is the honest v1
  (ADR 0011 rejects the general event bus).
- **Sidecars** (`curation-runs.json`, `intake-runs.json`) — advisory and fail-soft by design.
- **Commit signing / tamper-evidence** beyond git's DAG.
- **Attributing legacy commits** — impossible; they export `actor: null`.

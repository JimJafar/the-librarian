# ADR 0011 — Extension seams: a build-time plugin API

- **Status:** Accepted
- **Date:** 2026-07-12
- **Amends:** ADR 0008 (auth & secrets model) — the no-admin-on-public invariant becomes a factory-enforced default requiring an explicit plugin opt-out
- **Related:** ADR 0002, ADR 0003, ADR 0006

## Context

A commercial Teams edition — described in the Teams edition plan (private) —
will extend the Librarian with member accounts, layered team/personal vaults,
and a promotion flow. It must do this **without forking**: the private code
composes with the open-source core through published extension points, so
upstream refactors don't become merge fires and the open project gains
genuinely open extensibility rather than a hidden keyhole.

What the code offers today (mapped 2026-07-12):

- **No single composition root.** `packages/mcp-server/src/bin/http.ts`
  boots imperatively: env → store → `createHttpServer(...)` called
  twice (public `:3838`, internal tRPC `:3840` per ADR 0008) → route
  if-ladder in `http/routes.ts` keyed on `surface` → schedulers started
  in the listen callback.
- **Identity is fragmented and in soft-migration.** `AuthResult
  { role: "admin"|"agent", agentId?, scope?, tokenId? }` from
  `http/auth.ts`; the internal listener grants admin unconditionally;
  `ToolContext { role, agentId? }`; tRPC knows `admin|anonymous`;
  core's `ResolvedCaller` is threaded only through `scopeAgentArgs`;
  the single-token and localhost-bypass paths carry no identity;
  dashboard writes hardcode `dashboard-admin`.
- **The vault is single-rooted.** One git repo at `<dataDir>/vault`,
  layout owned by `vault-files.ts`, one lazily-cached corpus index,
  `routeMemoryWrite` deciding landing status only. No shelf concept
  exists anywhere.
- **All existing extensions are external processes** speaking the HTTP
  surface (the Pi extension's `pi.registerTool(...)` pattern, the
  Chromium client, the harness integrations). There is no in-process
  hook.

Three capabilities the Teams overlay needs and cannot get from outside
the process: replacing *who is this?* (member auth on both listeners),
deciding *which shelf?* (recall/write routing inside the store), and
adding admin surface (tRPC routers, dashboard pages, MCP tools).

## Decision

**Introduce a build-time plugin API behind a single composition root,
with two provider seams and three registration seams.**

1. **One composition root.** A new
   `createLibrarianServer(options): LibrarianServer` in
   `@librarian/mcp-server` owns what `bin/http.ts` does today: store
   construction, both listeners, schedulers, shutdown. The bin becomes
   a thin wrapper calling it with `plugins: []`. The Teams edition's
   own server package calls the same factory with its plugins. Spec:
   060.
2. **Plugins are build-time values, not discovered artifacts.** A
   plugin is an imported object passed to the factory — no dynamic
   loading, no plugin directory, no runtime discovery. Composition is
   a code change in whoever owns the entrypoint. This keeps the
   security model trivial (a plugin is code you deliberately linked)
   and the API surface small.
3. **Two provider seams (replace a default) and three registration
   seams (add to a registry):**
   - `authProvider` — one interface answering "who is this request?"
     per surface, returning a **Principal**; the OSS default reproduces
     today's behaviour exactly. Spec: 061.
   - `vaultRouter` — one interface answering "which shelves does this
     principal see, in what order, and where do writes land?"; the OSS
     default is a single shelf mapping to today's layout, byte-
     identical. Spec: 062.
   - `tools` (MCP `ToolDefinition[]`, appended to the existing
     registry), `trpcRouters` (merged under a plugin namespace), and
     `routes` (HTTP handlers declaring their `surface`). Name/path
     collisions are boot errors, not silent overrides.
4. **Principal becomes the one identity currency.** `AuthResult`,
   `ToolContext`'s role/agentId pair, and the tRPC role collapse into a
   single `Principal` threaded from listener to store write. This also
   finishes the identity soft-migration: every path yields an explicit
   principal (including the identity-less legacy paths, which yield a
   named sentinel). Per-actor provenance continues to live in
   **committed file content** (frontmatter `agent_id`), not git commit
   authorship — changing git authorship is explicitly *not* part of
   this decision. **This knowingly amends the Teams edition plan
   (private) §4**, which promised per-principal commit authorship: the
   audit chain is frontmatter provenance + the activity surface, and
   the plan's wording is corrected to match. If the promotion-flow UX
   later genuinely needs per-principal commit authors, a commit-author
   hook is an ADR-worthy widening, not a silent one.
5. **Shelves are subtrees of the one vault repo.** A shelf is a rooted
   prefix inside the single git repository (OSS: the empty prefix),
   each containing the canonical layout. One repo keeps the product's
   whole story intact: one history, one backup, one export,
   promotion-as-`git mv`. Per-shelf indexes; recall consults shelves
   in router order and labels every hit with its shelf.
6. **Seam types are public, semver-disciplined API.** The plugin-facing
   types are exported from dedicated entrypoints and changes to them
   are breaking changes (CHANGELOG discipline). Everything *not*
   exported through a seam remains private and refactorable at will —
   this is the point: a small stable surface so the rest can stay
   fluid.

## Alternatives rejected

- **Fork and merge** — the merge tax compounds forever; every upstream
  refactor becomes a fire (the Teams edition plan (private) §2 already
  rejected this).
- **Publish the internals** (`@librarian/core` et al. to npm) — makes
  every internal a public contract with semver obligations to
  strangers; taxes exactly the refactoring freedom the project needs.
- **Sidecar/proxy composition** — cannot reach recall ranking, write
  routing, or grooming; fine for auth alone, useless for shelves.
- **Dynamic plugin loading** (directory scan / runtime install) —
  buys nothing for a build-time overlay, adds a supply-chain attack
  surface and version-skew hell to a product whose brand is trust.
- **A general hook/event bus** ("emit everything, let plugins listen")
  — seductive and unownable; every emission point becomes load-bearing
  API by accident. Named seams keep the contract legible.

## Consequences

- The boot path gets refactored once (`bin/http.ts` →
  `createLibrarianServer`), a real but bounded risk: the existing
  integration tests plus a byte-identical-behaviour gate in spec 060
  cover it. Self-hosters see no change.
- The seam types become a compatibility promise. The cost is
  deliberateness: widening a seam is an ADR-worthy event, and the
  Teams overlay may only import through seams (enforced by lint in the
  private repo). The nightly drift build (the Teams edition plan
  (private) §6) is the tripwire.
- Store internals (`vault-files`, corpus index, grooming source
  iteration) get parameterised by shelf — the most invasive change,
  paid once, and inert under the default single-shelf router.
- The identity migration completes as a side effect: `unknown-agent`
  ambiguity and the hardcoded dashboard actor are replaced by explicit
  principals — an OSS quality win independent of Teams.
- The two-listener security model (ADR 0008) changes character in one
  place, deliberately: today "no admin on the public port" is
  impossible in code (`auth.ts` has no public admin branch); under a
  pluggable auth provider it becomes a **factory-enforced default** —
  the factory refuses admin-role principals on the public surface and
  refuses `/trpc/*` mounts there, unless a plugin sets an explicit,
  named opt-out. A buggy provider therefore cannot silently grant
  network callers admin; a deliberate one must say so in code. This is
  the amendment to ADR 0008 named in the header.
- Third parties get the same seams the Teams edition uses — the
  neutrality claim in the Teams edition plan (private) §2 ("genuinely
  open rather than open-with-a-hidden-keyhole") becomes checkable.
- Anything the seams don't reach (dashboard nav is static arrays; no
  capability descriptor exists yet — seam S4) stays out of scope here;
  S4–S7 are separate, smaller specs that can follow independently.

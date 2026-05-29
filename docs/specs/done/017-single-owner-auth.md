# Spec: Single-owner auth — dashboard login + token management

## Status

Drafted 2026-05-24. Five serial PRs (A1–A5). Phase 3 of the "reduce self-hosting friction"
initiative (Deploy → Persistence → Auth). Do this **last** — it is the largest surface, benefits
from backup existing (A3+ writes token state into the DB), and the wide-open dashboard is mitigated
by VPN-gating today, so it is the least urgent of the three even though it matters.

## Objective

Close two friction/security gaps for a **single-owner** deployment:

1. The **dashboard has no auth** — it relies on running behind a VPN. Add owner login via GitHub /
   Google so it can be exposed safely.
2. **MCP agent tokens are hand-edited** in `LIBRARIAN_AGENT_TOKENS` env + a restart. Let the
   authenticated owner **generate/revoke** agent tokens from the dashboard, stored in the DB. Clients
   still paste one generated token once.

**Explicitly out of scope: full browser-based MCP OAuth** (the MCP authorization spec —
`/.well-known`, an authorization server, the client OAuth dance). It is ~10–20× the cost of this
phase for the marginal win of "no token is ever pasted," and for a single-owner tool that residual
friction is tiny. Revisit later, almost certainly via a managed provider (Auth0/WorkOS/Stytch/
Cloudflare), when there are non-technical users or many clients.

**The current state.**

- **MCP auth is one seam**: `authenticateMcp(req, config)` in `packages/mcp-server/src/http/auth.ts`
  (timing-safe bearer; `LIBRARIAN_ADMIN_TOKEN`→admin, `LIBRARIAN_AGENT_TOKEN`/`LIBRARIAN_AGENT_TOKENS`
  →agent; no-auth localhost bypass in `bin/http.ts` when no admin token). The tRPC context
  (`src/trpc/context.ts`) calls the **same** function, so one change covers `/mcp` and `/trpc/*`.
  Identity → `ToolContext {role, agentId}` via `scopeAgentArgs`/`resolveCaller`.
- **Dashboard**: Next.js 15 app-router, stateless. **No auth/middleware**. Browser → same-origin
  proxy `app/api/trpc/[trpc]/route.ts` (only a `sec-fetch-site` CSRF check today) which injects
  `LIBRARIAN_ADMIN_TOKEN` server-side; SSR via `lib/trpc-server.ts`. tRPC admin procedures
  (`memories.*`, `sessions.*`, `curator.*`) gated by `adminProcedure` (`src/trpc/{trpc,context,router}.ts`).
- **`settings` table already exists** (`settings-store.ts`) and **survives schema bumps** — the home
  for token records, **no `PROJECTION_SCHEMA_VERSION` bump needed**.
- No OAuth/`.well-known`/session anywhere today.

**Success means:** with `LIBRARIAN_AUTH_ENABLED=true`, the dashboard requires an allowlisted owner
login (GitHub/Google); the owner generates/revokes agent tokens in a `/tokens` UI; those DB tokens
authenticate on `/mcp` with **no restart**; legacy env tokens still work; and the `/api/trpc` proxy
is session-gated so the dashboard's admin power is never reachable without a session.

## Non-goals

- **Not multi-user / multi-tenant.** Single owner, allowlisted by provider account id. No accounts,
  no per-user data, no org/RBAC.
- **Not full MCP OAuth** (see Objective).
- **Not a DB-backed session store.** JWT sessions keep the dashboard's "never opens the store"
  invariant; the only state needed is the owner allowlist (env).
- **Not removing env tokens.** `LIBRARIAN_AGENT_TOKENS`/`LIBRARIAN_AGENT_TOKEN` stay supported
  (backward compatible); the DB path is additive and preferred.

## Decisions (resolved)

- **Auth.js v5 (beta) on Next 15 app-router** for dashboard login. Pin a version; **use Context7 for
  the current Auth.js v5 + Next 15 API before writing** (the API moved between v4/v5).
- **JWT sessions**, single-owner **allowlist by provider account id** (GitHub numeric id / Google
  sub; email accepted as a documented alternative but ids are more robust).
- **DB agent tokens stored as salted SHA-256 hashes** (tokens are high-entropy random, not
  passwords — fast hash is sufficient; scrypt is overkill). Plaintext returned **once** on creation.
  Stored in the `settings` table under `agent_token:<id>` → `{agentId,label,hash,created_at}` (so even
  `getSetting` exposure is non-reversible — hashing beats the curator's reversible-encryption pattern
  here).
- **The single `authenticateMcp` seam** gets an injected `verifyDbToken` hook → covers `/mcp` and
  tRPC at once. DB tokens resolve to `role:"agent"`, so they **cannot** reach admin tRPC.
- **Feature-flagged rollout** (`LIBRARIAN_AUTH_ENABLED`): wire login first (off), then flip
  enforcement on — so no PR can lock the owner out mid-rollout.
- **Mergeable in slices**: login wired (A1) → enforced (A2) → core tokens (A3) → MCP accepts them
  (A4) → management UI (A5).

## Tech stack

- `next-auth@^5` (Auth.js v5) with GitHub + Google providers — **new dashboard dependency**.
- `node:crypto` (`randomBytes`, salted SHA-256, `timingSafeEqual`) for tokens — no new core dep.
- Reuses `settings-store`, the `authenticateMcp` seam, `adminProcedure` + the curator router/cockpit
  pattern, `components/ui-v2` primitives, the Playwright e2e harness (`apps/dashboard/e2e/`).

## Plan (PRs)

### A1 — Auth.js v5 wired (not enforced)

- **Create** `apps/dashboard/auth.ts` — `NextAuth({...})` exporting `handlers`, `auth`, `signIn`,
  `signOut`. Providers: GitHub + Google. **JWT** session strategy. Single-owner allowlist in the
  `signIn` callback: permit only when the provider account id matches `LIBRARIAN_OWNER_GITHUB_ID` /
  `LIBRARIAN_OWNER_GOOGLE_ID` (or `LIBRARIAN_OWNER_EMAILS`); deny by default if unconfigured.
- **Create** `apps/dashboard/app/api/auth/[...nextauth]/route.ts` (`export { GET, POST }`),
  `apps/dashboard/app/login/page.tsx` (GitHub/Google sign-in buttons).
- **Modify** `apps/dashboard/package.json` (`next-auth@^5`), `.env.example` + `DEPLOYMENT.md` (new env).
- **New env**: `AUTH_SECRET`, `AUTH_GITHUB_ID/SECRET`, `AUTH_GOOGLE_ID/SECRET`,
  `LIBRARIAN_OWNER_GITHUB_ID` (+Google / `LIBRARIAN_OWNER_EMAILS`), `AUTH_URL`,
  `LIBRARIAN_AUTH_ENABLED` (default **off** this PR).
- **Tests**: unit-test the `signIn` allowlist callback (allowed id → true; other id → false;
  missing config → deny).
- **Acceptance**: login works end-to-end behind the flag; nothing enforced yet (mergeable safely).

### A2 — Middleware gating + proxy session check

- **Create** `apps/dashboard/middleware.ts` — Auth.js middleware redirecting unauthenticated
  requests to `/login`; matcher excludes `_next`, `/login`, `/api/auth`, `/api/health`.
- **Modify** `apps/dashboard/app/api/trpc/[trpc]/route.ts` — **also** require a valid session
  (call `auth()`) alongside the existing `sec-fetch-site` check. This is critical: middleware can be
  bypassed for API routes, and the proxy injects the admin token — without this, the dashboard's
  admin power stays reachable without a session.
- **Modify** gate enforcement on `LIBRARIAN_AUTH_ENABLED` (default **on** in the combined image's
  recommended config); add a sign-out control to the layout/header.
- **Reuse**: the existing proxy CSRF check — layer the session check beside it.
- **Tests**: Playwright (unauth → redirected to `/login`; authed mock session → reaches a page);
  Vitest for the proxy session-gate (no session → 401/403).
- **Acceptance**: the wide-open-dashboard hole is fully closed (pages **and** the tRPC proxy).

### A3 — Core: DB-stored agent tokens (hashed)

- **Create** `packages/core/src/auth/agent-tokens.ts`:
  - `createAgentToken(store, { agentId, label }): { id, token }` — generate via `randomBytes`,
    return plaintext **once**, store only a salted SHA-256 hash.
  - `listAgentTokens(store)` — metadata only (`id`, `agentId`, `label`, `created_at`, `last_used_at`);
    never the token/hash.
  - `revokeAgentToken(store, id)`.
  - `verifyAgentToken(store, presented): { agentId } | null` — timing-safe over candidate hashes.
  - Storage: `settings` table, key `agent_token:<id>` → JSON `{agentId,label,hash,created_at}` via
    `setSetting`/`listSettings`/`deleteSetting`. **No schema bump.**
- **Create** `packages/core/tests/auth/agent-tokens.test.ts`.
- **Reuse**: `settings-store`; `randomBytes`/`timingSafeEqual` (share the helper from `http/auth.ts`
  or use `node:crypto` in core).
- **Tests (RED first)**: create → returns plaintext once + verify succeeds; wrong token → null;
  revoke → verify null; `list` never includes hash/plaintext; two tokens for the same agentId both
  verify to that agentId.
- **Acceptance**: token lifecycle works in core, independent of HTTP; hashes never leak.

### A4 — `authenticateMcp` accepts DB tokens (backward-compatible)

- **Modify** `packages/mcp-server/src/http/auth.ts` — add `verifyDbToken?: (token) => { agentId? } | null`
  to `AuthConfig`; after env-token checks fail, consult it. Keeps `authenticateMcp` pure-over-config
  (testable). Env tokens checked first (backward compat).
- **Modify** `packages/mcp-server/src/bin/http.ts` — set
  `auth.verifyDbToken = (t) => verifyAgentToken(store, t)`. Flows to `/mcp` **and** tRPC via the
  shared seam; DB tokens are `role:"agent"` (cannot reach admin tRPC).
- **Optional** `routes.ts` `/healthz` — report `db_tokens: "enabled"` when any exist.
- **Reuse**: the single seam; existing `timingSafeEqual`; the `startHttpServer` test helper.
- **Tests**: extend `packages/mcp-server/tests/http/routes.test.ts` — a DB-issued token authenticates
  on `/mcp` (seed via `createAgentToken`); a revoked token → 401; an env token still works; a DB
  agent token is rejected on an admin tRPC procedure. Add/revoke needs **no restart**.
- **Acceptance**: DB tokens authenticate live; revocation is immediate; env path unbroken; agent
  tokens can't escalate.

### A5 — Token-management router + dashboard UI

- **Create** `packages/mcp-server/src/trpc/tokens.ts` — `adminProcedure` router: `list` (metadata),
  `create` (`{agentId,label}` → `{id,token}` once), `revoke` (`{id}`); call the core `agent-tokens`
  functions on `ctx.store`. Mount in `trpc/router.ts` as `tokens`.
- **Create** `apps/dashboard/app/tokens/{page.tsx,actions.ts}` + `apps/dashboard/components/tokens/*`
  — list (metadata), a "Generate token" form (agentId + label), a **one-time reveal** of the new
  token with a copy button, revoke buttons. Clone `app/curator/*` + reuse `components/ui-v2`
  (`dialog`, `button`, `input`, `table`). Add a "Tokens" nav entry (gated by the A1/A2 session).
- **Modify** `DEPLOYMENT.md` — `LIBRARIAN_AGENT_TOKENS` env is now optional/legacy; the dashboard is
  the preferred path.
- **Reuse**: `adminProcedure`; curator router + cockpit components as the template.
- **Tests**: `packages/mcp-server/tests/trpc/tokens.test.ts` (admin-gated; create → list shows
  metadata; revoke → gone; non-admin rejected); dashboard action/component tests mirroring
  `tests/components/curator/*` + `tests/memories-actions.test.ts`; Playwright (login → generate →
  one-time reveal → revoke).
- **Acceptance**: the owner manages agent tokens entirely from the UI; plaintext shown exactly once.

## Verification (end-to-end)

With `LIBRARIAN_AUTH_ENABLED=true`:

```
# dashboard gating
open :3000/                         # unauthenticated → redirect to /login
curl -X POST :3000/api/trpc/...     # no session → 401/403
# sign in with the allowlisted GitHub/Google account → dashboard loads; non-allowlisted → denied
# token lifecycle
# /tokens → generate token for agentId "claude" → plaintext shown once → copy
curl -s -X POST :3838/mcp -H "Authorization: Bearer <generated>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'   # 200 (no restart)
# revoke it in the UI →
curl … same token                  # 401 (no restart)
# backward compat + isolation
curl … with LIBRARIAN_AGENT_TOKEN env value   # still 200
# a DB agent token on an admin tRPC procedure → rejected (role check)
```

`agent-tokens.test.ts`, `tokens.test.ts`, updated `routes.test.ts`, the proxy session-gate test,
and the Playwright login/token e2e all green; `pnpm -w test`/`typecheck` green.

## Risks / open items

- **Auth.js v5 is beta** — widely used and stable in practice; pin a version and verify the API via
  Context7 before writing.
- **The `/api/trpc` proxy gate (A2) is the easy thing to miss** — without it, middleware-only gating
  leaves the admin-powered proxy open. Called out explicitly.
- **No schema bump** (reuses `settings`) → existing remote deployments upgrade by pulling the image
  with no projection rebuild.
- **`AUTH_URL` / callback config** must match the deployed dashboard origin (document for the Fly /
  docker one-liner from the Deploy spec).
- **Allowlist source** (account id vs email) — default to account id; document how to find it.

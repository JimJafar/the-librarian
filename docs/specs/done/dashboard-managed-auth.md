# Spec: Dashboard-managed auth — self-service setup + password login

## Status

Drafted 2026-05-25. Follow-on to [`single-owner-auth.md`](./done/single-owner-auth.md) (A1–A5,
shipped). Five serial PRs (**D1–D5** — A=auth, B=persistence, C=deploy are already taken by the
shipped friction-initiative specs). Phase: "reduce self-hosting friction" — this removes the auth
env-var wall that A1–A5 left behind and adds a password option so deployers are not forced to own a
GitHub/Google account.

Spec reviewed; the four open questions are **resolved** (see Decisions). Implementation plan lives in
[`dashboard-managed-auth-plan.md`](./dashboard-managed-auth-plan.md).

## Objective

Today auth is real but configured **entirely through ~9 env vars** (`LIBRARIAN_AUTH_ENABLED`,
`AUTH_SECRET`, `AUTH_URL`, `AUTH_GITHUB_ID/SECRET`, `AUTH_GOOGLE_ID/SECRET`, `LIBRARIAN_OWNER_*`) and
flipping it on means a redeploy. Two problems:

1. **Friction.** Standing up login means editing env on the host and restarting. There is no in-app
   path. A fresh install is wide open and stays that way until someone does env surgery.
2. **OAuth-only locks out the IdP-averse.** A deployer with no GitHub/Google account (or who refuses
   to tie their tooling to one) currently cannot enable auth at all.

**Build:** a `/settings/auth` flow in the dashboard where the owner enables auth and configures
**any combination** of (a) username + password, (b) GitHub OAuth, (c) Google OAuth — with config
living in the store, not env. Plus a CLI break-glass for lockout recovery.

**Success looks like:** a fresh install is open (as today); the owner opens `/settings/auth`,
proves they are the operator by pasting the admin token once, sets a password and/or wires an OAuth
provider through a guided wizard, and enforcement flips on **without a redeploy**; the only surviving
auth-relevant env var is `LIBRARIAN_SECRET_KEY` (already required for secret settings). A forgotten
password is recoverable from the server shell.

### Reframed success criteria (testable)

- Auth/secret env vars required on a **fresh install: 0**. `LIBRARIAN_SECRET_KEY` and
  `LIBRARIAN_ADMIN_TOKEN` are auto-generated to the data volume on first boot when unset (D0); env
  still wins when set, for operators who want key/data separation. `LIBRARIAN_MCP_URL` remains as
  service wiring.
- Enabling auth, setting a password, and wiring an OAuth provider are all doable from the dashboard
  with **zero process restarts**.
- A deployer with **no GitHub/Google account** can fully secure the dashboard (password only).
- A wrong password is rejected; **N consecutive failures trigger lockout**; lockout survives a
  restart; the lockout clears via the CLI.
- `the-librarian auth reset-password` on the host restores access from a forgotten-password lockout.
- Existing A1–A5 env-configured deployments keep working unchanged (legacy env = deprecated
  fallback).

## Non-goals

- **Not multi-user / multi-tenant.** Still a single owner with one or more unlock methods.
- **Not full MCP OAuth** (unchanged from the prior spec).
- **Not a DB-backed *session* store.** JWT sessions stay; only *config* moves into the store.
- **Not removing the admin token or MCP URL** — those are deployment infra, out of scope here.
- **Not password-strength theatre** (no forced rotation, complexity regex). One owner, a length
  floor, and lockout are the proportionate controls.

## Current state (grounded)

- **`apps/dashboard/auth.ts`** — Auth.js v5, **static** providers `[GitHub, Google]`, `trustHost: true`,
  JWT sessions, `signIn` callback → `isAllowedOwner` (reads env). All config inferred from env at
  module init.
- **`apps/dashboard/middleware.ts`** — enforcement decided **once at module init** via
  `isAuthEnforced()` reading `LIBRARIAN_AUTH_ENABLED`. The deliberate reason (documented in
  `lib/auth-gate.ts`): `auth()` throws loudly when `AUTH_SECRET` is unset, so the un-enforced path
  must never reach the wrapper. A2 made the `/api/trpc` proxy **fail-closed** behind a session.
- **`apps/dashboard/lib/owner-allowlist.ts`** — pure, env-driven, deny-by-default.
- **`packages/core/src/store/settings-store.ts`** — `setSetting/getSetting/deleteSetting/listSettings`;
  `{secret:true}` values are AES-256-GCM encrypted at rest via `secret-crypto` keyed by
  `LIBRARIAN_SECRET_KEY`; `listSettings` is metadata-only (values never leak through listing). The
  `settings` table survives schema bumps — **no projection bump needed**.
- **`packages/core/src/auth/agent-tokens.ts`** — the model to copy: random ids, salted SHA-256 hash
  stored as a *plain* setting (a hash is already non-reversible), timing-safe verify, plaintext shown
  once. We mirror its shape for password + setup-link records.
- **`packages/cli/src/runtime.ts`** — dispatches top-level commands (`backup`, `export`, `restore`)
  and `sessions <verb>`; constructs the store with the secret key. Adding `auth <verb>` follows the
  `sessions <verb>` pattern exactly.
- **Topology:** dashboard and MCP server are **separate** services. Browser → same-origin proxy
  `app/api/trpc/[trpc]/route.ts` (injects `LIBRARIAN_ADMIN_TOKEN`) → MCP server tRPC. The dashboard
  does **not** hold `LIBRARIAN_SECRET_KEY`; the store does.

## Decisions (resolved)

- **Config home = the `settings` table on the store**, read/written by the dashboard via new
  `adminProcedure` tRPC procedures (over the existing admin-token proxy). Keeps the "dashboard never
  opens the store directly" invariant. **No schema bump.**
- **Root-of-trust = `LIBRARIAN_SECRET_KEY`, auto-provisioned (D0).** Enabling auth requires a key,
  but it no longer has to be an env var — D0 generates one to the data volume on first boot if unset
  (env still wins). OAuth client secrets are stored `{secret:true}` (reversible, need the key); the
  password is stored as a *plain* one-way hash (verifiable without the key), like agent tokens.
- **Credential bootstrap (D0): auto-generate the master key and admin token.** On first boot, if
  `LIBRARIAN_SECRET_KEY` is unset, generate one to `${LIBRARIAN_DATA_DIR}/secret.key` (mode 0600) and
  log a one-time notice; if `LIBRARIAN_ADMIN_TOKEN` is unset **and** the server binds beyond localhost
  (today a fatal error), generate one to `${LIBRARIAN_DATA_DIR}/admin.token` (0600) and print it once.
  Env always wins; the localhost no-auth bypass is unchanged. Backups stay **key-free** —
  `the-librarian restore` prompts for the master key (or accepts `--secret-key`) on a host that lacks
  it, so a leaked backup is not a leaked key. The one-time log must tell the operator to **save the
  key**, since without it restored secrets can't be decrypted.
- **JWT signing key (`AUTH_SECRET`) is HKDF-derived from `LIBRARIAN_SECRET_KEY` on the store side**
  (`HKDF(key, info="dashboard-jwt-v1")`) and handed to the dashboard via the auth-config procedure.
  Nothing to store, nothing extra to rotate; rotating the master key rotates sessions.
- **Password hashing = `scrypt` (`node:crypto`)** with tuned cost params, salted, timing-safe
  compare. No native dependency. (argon2id is the gold standard but needs a native dep — see Open
  Questions.)
- **Password verification + lockout run on the store side** via `auth.verifyPassword` — the hash and
  the failure counters never leave the store, and rate-limiting is centralized. Auth.js's Credentials
  `authorize()` just calls this procedure.
- **Three independent unlock methods for one owner.** Configure any subset; any one logs in. The
  owner identity for OAuth is still an allowlisted provider account id; for password it's an
  **operator-chosen username** set during setup (stored alongside the hash).
- **Bootstrap land-grab is closed by requiring the admin token in the one-time "enable auth" step.**
  Before enforcement is on, the proxy is open, so any visitor could otherwise drive the enable
  mutation. `auth.enable` requires the caller to supply the admin token, verified timing-safe against
  the configured one.
- **Dynamic Auth.js config** via the v5 lazy form `NextAuth(async () => ({...}))`, fed by an
  in-process cache of the auth-config procedure with **explicit bust on mutation** + a short TTL.
- **Fail-closed enforcement.** Enforcement flips on only when config is *complete and validated*. At
  runtime, `enabled=true` with unreadable/incomplete config → **block** (redirect to an error/login
  surface that names the CLI recovery), never fail open. Matches A2's posture.
- **Legacy env = deprecated fallback.** Store config wins when present; otherwise fall back to the
  A1–A5 env vars so existing deployments are untouched. Documented for removal in a later major.
- **Lockout recovery = CLI on the host** (chosen): `the-librarian auth reset-password`. Leverages the
  shell access a self-hoster already has; zero new env vars. Supports both an inline
  `--password`/prompt and **`--print-setup-link`** — a one-time, short-TTL (15 min) link the owner
  opens in the browser to set the password, keeping plaintext out of shell history. The setup-link is
  a hashed, single-use record in `settings` (mirrors the agent-token shape).

## Tech stack

- `next-auth@^5` (Auth.js v5) — already a dependency; **verify the v5 lazy-config + Credentials API
  via Context7 before writing** (the API moved between v4/v5).
- `node:crypto` — `scrypt`, `randomBytes`, `hkdf`, `timingSafeEqual`. No new runtime dep.
- Reuses `settings-store` (+ `secret-crypto`), `adminProcedure` + the curator/tokens router pattern,
  `components/ui-v2` primitives, the dashboard Playwright harness (`apps/dashboard/e2e/`), and the
  CLI `sessions <verb>` dispatch pattern.

## Commands

```
Install:    pnpm install
Build:      pnpm -r run build
Test (all): pnpm test                       # builds, runs every package's vitest, then root vitest
Core/MCP:   pnpm --filter @librarian/core run test:vitest
            pnpm --filter @librarian/mcp-server run test:vitest
CLI:        pnpm --filter @librarian/cli run test:vitest
Dashboard:  pnpm --filter @librarian/dashboard run test:vitest   # vitest (component/action)
            pnpm --filter @librarian/dashboard run test:e2e      # Playwright
Typecheck:  pnpm -r run typecheck
Lint/Fmt:   pnpm lint            |  pnpm format:check
Dev:        pnpm --filter @librarian/dashboard run dev           # :3000
```

## Project structure (files this spec adds/changes)

```
packages/core/src/             # D0 — credential bootstrap
  secret-crypto.ts        → MODIFY: loadOrCreateSecretKeyFile(path) — read or generate the key file.
  auth/admin-token.ts     → NEW: loadOrCreateAdminTokenFile(path) — read or generate the admin token.
packages/core/src/auth/
  auth-config.ts          → NEW: get/set enabled flag, owner methods, OAuth creds (secret),
                            AUTH_SECRET derivation, admin-token verify. Mirrors agent-tokens.ts.
  password.ts             → NEW: scrypt hash/verify (operator-chosen username), lockout
                            accounting, and one-time setup-link records (hashed, short-TTL).
packages/core/tests/auth/
  auth-config.test.ts     → NEW
  password.test.ts        → NEW
packages/mcp-server/src/bin/
  http.ts                 → MODIFY (D0): bootstrap key + admin token (env → file → generate).
packages/mcp-server/src/trpc/
  auth.ts                 → NEW: adminProcedure router — config (read), enable, disable,
                            setPassword, configureOAuth, setOwner, verifyPassword.
  router.ts               → MODIFY: mount as `auth`.
packages/mcp-server/tests/trpc/
  auth.test.ts            → NEW
packages/cli/src/commands/
  auth.ts                 → NEW: `auth <verb>` — reset-password (--password|--print-setup-link),
                            disable, status.
  restore.ts              → MODIFY (D0): prompt for / accept --secret-key when restored secrets
                            need a key the host lacks.
  index.ts / runtime.ts   → MODIFY: register the `auth` top-level command.
packages/cli/tests/
  auth-commands.test.ts   → NEW
apps/dashboard/
  auth.ts                 → MODIFY: static providers → lazy config from the store (cached).
  middleware.ts           → MODIFY: enforcement from store config (cached), fail-closed.
  lib/auth-gate.ts        → MODIFY: enabled flag from config, not env (env fallback).
  lib/auth-config-client.ts → NEW: in-process cache + bust around the auth-config procedure.
  app/settings/auth/page.tsx, actions.ts → NEW: the setup flow.
  app/settings/auth/reset/page.tsx       → NEW: consume a one-time setup link → set password.
  components/settings/auth/*            → NEW: enable card, password form, OAuth wizard,
                            owner/method list, disable control.
  app/login/page.tsx      → MODIFY: render a username/password form when password is configured.
  e2e/auth-setup.spec.ts  → NEW
```

## Code style

One representative snippet — core config storage mirrors `agent-tokens.ts` (pure functions over a
`SettingsLike`, JSON records, no I/O beyond the store):

```ts
// packages/core/src/auth/password.ts
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY = "auth:password";
const N = 16384, r = 8, p = 1, KEYLEN = 64; // tuned scrypt cost

interface PasswordRecord {
  username: string;
  salt: string;
  hash: string;
  updated_at: string;
}

export function setOwnerPassword(store: SettingsLike, username: string, password: string): void {
  assertPasswordPolicy(password); // length floor only; no complexity theatre
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, KEYLEN, { N, r, p }).toString("hex");
  const record: PasswordRecord = { username, salt, hash, updated_at: new Date().toISOString() };
  store.setSetting(KEY, JSON.stringify(record)); // plain: a hash is already non-reversible
}

export function verifyOwnerPassword(store: SettingsLike, username: string, password: string): boolean {
  const raw = store.getSetting(KEY);
  if (!raw) return false;
  const rec = JSON.parse(raw) as PasswordRecord;
  if (rec.username !== username) return false;
  const candidate = scryptSync(password, rec.salt, KEYLEN, { N, r, p });
  const stored = Buffer.from(rec.hash, "hex");
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}
```

Conventions: comments explain *why* (the security reasoning), not *what*; deny/fail-closed by
default; secrets never returned through list/metadata surfaces; pure-over-store so logic is testable
without HTTP.

## Testing strategy

- **Core (vitest, RED first):** `password.ts` — set→verify ok; wrong password→false; wrong
  username→false; lockout after N failures; lockout persists across a fresh store handle; reset
  clears it. `auth-config.ts` — enable requires a matching admin token; OAuth secret round-trips
  encrypted; `config` read never returns the raw password hash; AUTH_SECRET derivation is stable for
  a key and changes when the key changes.
- **MCP tRPC (vitest):** `auth.test.ts` — every mutation is admin-gated (non-admin rejected);
  `enable` rejects a wrong admin token; `verifyPassword` enforces lockout; `disable` flips
  enforcement off.
- **CLI (vitest):** `auth-commands.test.ts` — `reset-password` writes a new verifiable hash + clears
  lockout; `disable` turns enforcement off; `status` reports configured methods (no secrets).
- **Dashboard (vitest):** action/component tests mirroring `tests/components/curator/*` — the wizard
  validates input, the cache busts on save, the login form appears only when password is configured.
- **E2E (Playwright):** fresh/open dashboard → `/settings/auth` → paste admin token → set password →
  enforcement on → sign in with password → wrong password locks out → (simulated) CLI reset → sign in
  again. Plus the OAuth wizard's "save creds → verify by signing in" happy path with a mocked
  provider.
- **Gate:** `pnpm test` + `pnpm typecheck` + `pnpm lint` green.

## Plan (PRs)

### D0 — Credential bootstrap (master key + admin token)
On first boot, resolve `LIBRARIAN_SECRET_KEY` (env → `${LIBRARIAN_DATA_DIR}/secret.key` → generate,
0600, log once) and `LIBRARIAN_ADMIN_TOKEN` (env → file → generate **only** when binding beyond
localhost, 0600, print once). Env always wins; the localhost no-auth bypass is unchanged. Backups
stay key-free; `restore` prompts for the master key (or `--secret-key`). Independently useful (not
auth-specific), so it lands first. **Acceptance:** a fresh `docker run` with no secret/admin env vars
boots secured; a restart reuses the persisted credentials (no regeneration); a restore onto a new
host decrypts after the key prompt; the backup bundle contains no key.

### D1 — Core auth-config + password (store-backed), env fallback
`auth-config.ts` + `password.ts` (incl. setup-link records) + tests. No behavior change yet (env
still authoritative; store additive). **Acceptance:** config + password + setup-link lifecycle works
in core, independent of HTTP; secrets never leak through reads/listing.

### D2 — `auth` tRPC router + dashboard reads config dynamically
`trpc/auth.ts` (admin) mounted in the router; dashboard `auth.ts`/`middleware.ts`/`auth-gate.ts`
switch to the cached store config (30s TTL + bust-on-mutation) with env fallback; fail-closed when
enabled-but-incomplete. **Acceptance:** flipping the enabled flag in the store enforces/de-enforces
with no restart; a store outage with `enabled=true` fails closed, not open.

### D3 — Password login (Credentials provider + lockout)
`verifyPassword` procedure wired to a Credentials provider; rate-limit/lockout on the credentials
path; `/login` renders the operator-chosen-username + password form when configured. **Acceptance:**
password login works end-to-end; lockout triggers and persists; OAuth still works alongside.

### D4 — CLI recovery (`the-librarian auth …`)
`auth reset-password | disable | status` via the `sessions <verb>` pattern; `reset-password` supports
both `--password`/prompt and `--print-setup-link` (consumed by `/settings/auth/reset`).
**Acceptance:** a forgotten-password lockout is recoverable from the host shell (inline or via a
one-time browser link); `disable` is a true break-glass.

### D5 — Setup wizard UI
`/settings/auth`: enable (paste admin token), password setup, OAuth wizard (show callback URL → paste
client id/secret → verify-by-signin), method/owner management, disable. Playwright. **Acceptance:**
the owner configures every method from the UI; `.env.example`/`DEPLOYMENT.md` updated to mark the
A1–A5 auth env vars deprecated/optional.

Ordering: D0 → D1 → D2 → (D3 ∥ D4) → D5.

## Boundaries

- **Always:** fail closed on auth ambiguity; store the password only as a one-way hash — never the
  plaintext, never reversibly encrypted (the hash itself is a plain setting, like agent tokens); keep
  secrets out of `list`/`config` read surfaces; write bootstrap credential files (`secret.key`,
  `admin.token`) mode 0600 and **exclude them from backups**; run `pnpm test`/`typecheck`/`lint`
  before commit; verify the Auth.js v5 API via Context7 before writing; one PR per D-slice, each
  independently mergeable and non-locking.
- **Ask first:** adding a runtime dependency (e.g. argon2id native module); any `settings`-key naming
  that could collide with `agent_token:` / curator keys; changing the dashboard↔store trust boundary
  (e.g. giving the dashboard `LIBRARIAN_SECRET_KEY`); touching `PROJECTION_SCHEMA_VERSION`.
- **Never:** log or return the password, its hash, OAuth secrets, or `AUTH_SECRET`; log the admin
  token except the **single one-time generation notice** (D0); weaken A2's fail-closed proxy gate;
  let `enable` proceed without a verified admin token; remove the legacy env fallback without a
  deprecation cycle.

## Success criteria

See "Reframed success criteria" above — all are covered by the D0–D5 acceptance tests and the
end-to-end Playwright flow. Done = those green + `pnpm test`/`typecheck`/`lint` green + docs updated.

## Resolved decisions (formerly open questions)

1. **Password KDF → `scrypt`** (`node:crypto`) — no native dependency.
2. **CLI reset → both `--password`/prompt and `--print-setup-link`** (one-time, 15-min browser link).
3. **Password username → operator-chosen** at setup, stored alongside the hash.
4. **Auth-config cache TTL → 30s**, combined with bust-on-mutation.
5. **Master key + admin token auto-generated (D0)** to the data volume when unset; env wins.
6. **Backups stay key-free; `restore` prompts for the master key** — separation preserved over the
   likeliest leak vector (a stray backup), at the cost of one key entry during the rare restore.

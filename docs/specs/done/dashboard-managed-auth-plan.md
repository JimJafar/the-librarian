# Implementation plan: Dashboard-managed auth

Companion to [`dashboard-managed-auth.md`](./dashboard-managed-auth.md). The spec says *what* and
*why*; this plan says *in what order*, *how the pieces fit*, *what's risky*, and *how we verify each
step*. Five PRs **D1–D5**.

> **Verify before coding:** Auth.js v5's lazy/async config form (`NextAuth(async () => …)`),
> the Credentials provider shape, and the `auth()` middleware wrapper all moved between v4/v5 — pull
> the current API via Context7 at the start of D2/D3 rather than trusting memory.

## Component map

```
                       ┌─────────────────────────── store (MCP server) ───────────────────────────┐
                       │                                                                            │
 packages/core/src/auth/                         packages/mcp-server/src/trpc/                      │
   auth-config.ts  ──── enabled flag, owner       auth.ts (adminProcedure)                          │
                        methods, OAuth creds        · config()      → resolved runtime config       │
                        (secret), admin-token        · enable(adminToken) / disable()               │
                        verify, AUTH_SECRET          · setPassword / configureOAuth / setOwner      │
                        = HKDF(SECRET_KEY)           · verifyPassword(user,pw) → {ok}|lockout        │
   password.ts    ──── scrypt hash/verify,        router.ts: mount as `auth`                        │
                        lockout state,                                                               │
                        one-time setup links      settings table (no schema bump) ◄─────────────────┘
                                ▲                          ▲
                                │ (store access)           │ (admin-token tRPC proxy)
                                │                          │
 packages/cli/src/commands/auth.ts          apps/dashboard/
   reset-password (--password |               lib/auth-config-client.ts ── 30s cache + bust
     --print-setup-link)                      auth.ts        ── lazy NextAuth config from cache
   disable | status                           middleware.ts  ── enforce from cache, fail-closed
                                              app/login            ── + username/password form
                                              app/settings/auth/*  ── setup wizard + reset page
```

Two reuse anchors: `agent-tokens.ts` (the storage/verify/one-time-secret shape to copy) and the
curator/tokens tRPC router + cockpit components (the admin-router + dashboard-page template).

## Build order & parallelism

```
D0 ──► D1 ──► D2 ──► D3 ─┐
         └──────► D4 ────┴─► D5
```

- **D0** (credential bootstrap) is independent of the auth feature and lands first — it makes a
  master key always available, which D1's secret storage relies on.
- **D1** (core) is foundational — everything reads/writes through it.
- **D2** (dynamic config read) depends on D1.
- **D3** (password login) depends on D1 (verify) **and** D2 (the method must surface through the
  dynamic config + login form).
- **D4** (CLI) hard-depends only on **D1** (it writes core settings directly with its own store
  handle). It can start in parallel with D2 once D1 lands; its *observable* effect on a running
  dashboard (e.g. `disable`) is what needs D2.
- **D5** (wizard UI) depends on all of D1–D4.

**Sequencing safety constraint:** D4 (recovery) must be merged **before** D3's enforcement is turned
on in any exposed environment. A password lockout with no escape hatch is the one self-inflicted
outage this feature can cause — the break-glass has to exist first.

## Per-PR technical approach

### D0 — Credential bootstrap (master key + admin token)

- **`secret-crypto.ts`** gains `loadOrCreateSecretKeyFile(path)`: if the file exists, read+validate
  via the existing `resolveSecretKey`; else `randomBytes(32)` → write hex (open `wx`, mode `0600`) →
  return. **`auth/admin-token.ts`** gets the analogous `loadOrCreateAdminTokenFile(path)` (token shape
  e.g. `libadmin_<base64url>`).
- **`bin/http.ts`** resolution order, per credential: **env → `${LIBRARIAN_DATA_DIR}/<file>` →
  generate**. Key: generate only when a data dir is writable (else fall back to the existing
  null-key/no-secrets path with a warning — never crash). Admin token: generate only on the branch
  that today is fatal (binding beyond localhost with no token); the localhost no-auth bypass is
  untouched. Each generation logs **once** (the admin-token print is the sole sanctioned token log).
- **`restore.ts`**: after restoring, if a secret setting fails to decrypt with the resolved key,
  prompt for the master key (TTY) or read `--secret-key`; retry. Backups already bundle DB + events +
  memory files only — **add `secret.key`/`admin.token` to the exclude set** so the key never travels
  with the data.
- **Tests:** generate-on-missing then reuse-on-restart (no regen); env wins (no file written);
  unwritable dir → no-secrets fallback, not a crash; restore with the right key decrypts, wrong key
  errors clearly; backup bundle excludes the credential files; localhost-no-token path unchanged.

### D1 — Core: `auth-config.ts` + `password.ts`

- **`password.ts`** mirrors `agent-tokens.ts`:
  - `setOwnerPassword(store, username, password)` → scrypt, salted; **store `{N,r,p}` in the record**
    so cost can change later without invalidating old hashes. Plain setting (one-way hash).
  - `verifyOwnerPassword(store, username, password)` → timing-safe; returns the lockout-aware result.
  - Lockout state at `auth:lockout` → `{failures, firstFailureAt, lockedUntil}`; N=5 within a window
    → exponential lock, persisted (survives restart). `verify` increments on miss, clears on hit.
  - Setup links: `mintSetupLink(store, ttlMs)` → one-time, hashed record `auth:setup_link:<id>`,
    returns plaintext token once; `consumeSetupLink(store, token)` → validates unexpired/unused/hash,
    marks used.
- **`auth-config.ts`**:
  - `getAuthConfig(store)` → `{enabled, methods:{password?,github?,google?}, ownerOAuth, authSecret}`;
    decrypts OAuth secrets, derives `authSecret = hkdfSync(SECRET_KEY, "dashboard-jwt-v1")`.
  - `setEnabled`, `setOAuth(provider, {clientId, clientSecret})` (secret), `setOwner(...)`.
  - `enableAuth(store, presentedAdminToken)` — timing-safe compare to the configured admin token
    **and** validate completeness (≥1 method + derivable secret) **before** persisting `enabled=true`.
- **Tests (RED first):** password set/verify/lockout/persist/reset; setup-link one-time + expiry;
  config round-trips OAuth secret encrypted; `config` never returns the raw hash; `enableAuth` rejects
  a wrong/absent admin token and an incomplete config; AUTH_SECRET stable per key, changes with key.
- **No behavior change** — env still authoritative; this is additive.

### D2 — `auth` tRPC router + dynamic dashboard config

- **`trpc/auth.ts`** (all `adminProcedure`): `config`, `enable`, `disable`, `setPassword`,
  `configureOAuth`, `setOwner`, `verifyPassword`. Mount as `auth` in `router.ts`.
- **`lib/auth-config-client.ts`** — module-level cache: `getCached()` (fetch via tRPC if older than
  30s), `bust()` (called by every mutation action). Single dashboard instance ⇒ no cross-instance
  invalidation needed (note the assumption).
- **`auth.ts`** → lazy `NextAuth(async () => buildConfig(getCached()))`: providers assembled from
  config (GitHub/Google only when creds present; Credentials when a password is set — wired in D3);
  `secret` = the derived AUTH_SECRET; `signIn` callback allowlists OAuth owner from config (not env).
- **`middleware.ts` / `auth-gate.ts`** → enforcement from the cache, **fail-closed**: `!enabled` →
  pass; `enabled && configOk` → redirect unauth → `/login`; `enabled && !configOk` (store
  unreachable / incomplete) → block to a **store-independent** error page that names
  `the-librarian auth disable`. Keep A2's fail-closed `/api/trpc` proxy gate intact.
- **Env fallback:** when no store auth-config exists, fall back to the A1–A5 env vars (existing
  deployments untouched).
- **Tests:** mutations admin-gated; `enable` rejects wrong admin token; store outage with
  `enabled=true` fails closed (mock unreachable store); env-fallback path still authenticates;
  cache busts on mutation.

### D3 — Password login

- Credentials provider whose `authorize()` calls `auth.verifyPassword` (hash + lockout live
  store-side; nothing sensitive in the dashboard). JWT encodes the single-owner identity, consistent
  with the OAuth path.
- Rate-limit the credentials route at the dashboard (defense in depth) on top of the authoritative
  store-side lockout.
- `/login` renders the operator-chosen-username + password fields **only when** a password method is
  configured (read from cached config).
- **Tests:** password login e2e; bad password → reject; N misses → lockout that persists across a
  store restart; OAuth still works alongside.

### D4 — CLI recovery (`the-librarian auth …`)

- Register `auth` in `runtime.ts` dispatch (the `sessions <verb>` pattern); `commands/auth.ts`.
- `reset-password` → `--password <pw>` / interactive prompt **or** `--print-setup-link` (mints a
  15-min one-time link via `mintSetupLink`, prints the URL from the configured origin or `--origin`);
  clears lockout either way.
- `disable` → `setEnabled(false)` (break-glass; visible to the dashboard within the 30s TTL).
- `status` → configured methods + enabled flag, **no secrets**.
- **`app/settings/auth/reset/page.tsx`** consumes the link (`consumeSetupLink`) → set password.
- **Tests:** reset (inline + link) restores access from lockout; `disable` flips enforcement;
  `status` leaks nothing; link is single-use and expires.

### D5 — Setup wizard UI

- `/settings/auth`: **Enable** card (paste admin token → `enable`), **Password** setup (choose
  username + password), **OAuth wizard** per provider (show exact callback URL
  `<origin>/api/auth/callback/{github,google}` → paste client id/secret → save → "verify by signing
  in"), method/owner list, **Disable** control. Clone `app/curator/*` + `components/ui-v2`.
- Update `.env.example` + `DEPLOYMENT.md`: mark the A1–A5 auth env vars deprecated/optional; document
  `LIBRARIAN_SECRET_KEY` as the sole required auth env var and the admin-token bootstrap step.
- **Tests:** Playwright full flow (open → enable → set password → enforce → login → wrong-password
  lockout → CLI reset → login); OAuth wizard happy path with a mocked provider.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Ephemeral filesystem regenerates the auto-key each boot** → restored/old secrets become unreadable | Only auto-gen when the data dir is writable; the one-time log names the path; deploy docs require a persistent `/data` volume (already the contract) |
| Auto-gen key lost → restored secrets unrecoverable | The generation notice tells the operator to **save the key**; restore prompts for it; key stays out of the bundle by design |
| Credential file world-readable | Open with `wx` + mode `0600`; never widen |
| Auth.js v5 lazy-config / Credentials API uncertainty | Context7 + a small spike at the top of D2; keep provider assembly behind `buildConfig()` so the surface is swappable |
| **Fail-open regression** (the worst outcome) | Enforcement state machine with explicit fail-closed branch; `enableAuth` validates completeness *before* flipping the flag; dedicated outage test |
| Bootstrap land-grab during the open window | `enable` requires the operator's admin token (timing-safe compare); require an admin token be configured before auth can be enabled (document the localhost-bypass caveat) |
| **Owner self-lockout** | D4 recovery lands before D3 enforcement is exposed; bounded lock durations; `auth disable` break-glass |
| scrypt cost drift across hardware | Store `{N,r,p}` per record; calibrate to a target (~100ms) on reference hardware |
| Secrets in transit to the dashboard (OAuth secret, AUTH_SECRET) | Same-origin/loopback proxy only; admin-gated `config`; never logged; values stay out of `list`/metadata |
| Cache staleness for break-glass `disable` | 30s TTL bounds it; document that CLI changes take effect within the TTL (no restart) |
| Regressing A2's proxy gate or the env-configured deployments | Keep the proxy session check; env fallback path covered by a test |

## Verification checkpoints

- **After D0:** a fresh boot with no env + writable `/data` generates and persists key + admin token,
  logged once; a restart reuses them (no regen); env set → used as-is, no file written; restore on a
  new host decrypts after the key prompt; the backup bundle contains no credential files; the
  localhost no-auth path is unchanged.
- **After D1:** core tests green; **existing dashboard e2e still green** (no behavior change; env path
  untouched).
- **After D2:** toggling `enabled` in the store enforces/de-enforces with no restart; store-outage
  test fails closed; env-fallback login still works.
- **After D3:** password login e2e green; lockout triggers and survives a restart; OAuth coexists.
- **After D4:** `reset-password` (inline **and** setup-link) restores access from a lockout;
  `disable` takes effect within the TTL.
- **After D5:** full wizard Playwright flow green; `.env.example`/`DEPLOYMENT.md` updated; a
  password-only deploy (no GitHub/Google) is fully securable.
- **Gate (every PR):** `pnpm test` + `pnpm -r run typecheck` + `pnpm lint` green.

## Next phase

On plan approval, break D0–D5 into discrete tasks (acceptance + verify + files per task, ≤5 files
each) per the Tasks phase, then implement with TDD slice by slice.

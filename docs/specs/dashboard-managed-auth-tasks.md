# Tasks: Dashboard-managed auth

Task breakdown for [`dashboard-managed-auth.md`](./dashboard-managed-auth.md) /
[`dashboard-managed-auth-plan.md`](./dashboard-managed-auth-plan.md). Phase 3 (Tasks) — this is still
planning. No code until each task is approved and the Implement phase begins.

**Slice order:** D0 → D1 → D2 → (D3 ∥ D4) → D5. Within a slice, tasks are dependency-ordered.

**Per-task definition of done (applies to every task below, not repeated):** the task's own *Verify*
passes **plus** `pnpm -r run typecheck` and `pnpm lint` are green and no unrelated test regresses.
"(TDD)" marks tasks where the failing test is written first.

**Commands referenced:**
```
core:      pnpm --filter @librarian/core run test:vitest
mcp:       pnpm --filter @librarian/mcp-server run test:vitest
cli:       pnpm --filter @librarian/cli run test:vitest
dashboard: pnpm --filter @librarian/dashboard run test:vitest
e2e:       pnpm --filter @librarian/dashboard run test:e2e
```

---

## D0 — Credential bootstrap (master key + admin token)

- [ ] **D0.1 — `loadOrCreateSecretKeyFile(path)`** (TDD)
  - Acceptance: returns the validated key when the file exists (reuses `resolveSecretKey`); generates
    a 32-byte CSPRNG key written as 64-char hex with `open('wx', 0o600)` when absent; throws on a
    malformed existing file; never widens perms; reports whether it generated (for the one-time log).
  - Verify: `core` — new `secret-crypto` cases (exists / missing→generate / malformed / reuse-on-2nd-call).
  - Files: `packages/core/src/secret-crypto.ts`, `packages/core/tests/secret-crypto.test.ts`,
    `packages/core/src/index.ts`.

- [ ] **D0.2 — `loadOrCreateAdminTokenFile(path)`** (TDD)
  - Acceptance: reads an existing token; else generates `libadmin_<base64url>` (≥32 bytes entropy)
    written `0600`; validates shape on read; returns a generated-flag.
  - Verify: `core` — new `auth/admin-token` test (exists / generate / reuse / perms).
  - Files: `packages/core/src/auth/admin-token.ts`, `packages/core/tests/auth/admin-token.test.ts`,
    `packages/core/src/index.ts`.

- [ ] **D0.3 — `resolveBootCredentials({env, dataDir, boundBeyondLocalhost, fs})`** (TDD)
  - Acceptance: pure resolver encoding the decision matrix — key: env → file → generate (when dataDir
    writable) → null (no-secrets fallback, no crash); admin token: env (incl. legacy
    `LIBRARIAN_AUTH_TOKEN`) → file → generate **only** when `boundBeyondLocalhost`; localhost + no
    token → returns "no token / bypass" unchanged. Emits structured "generated" signals for logging.
  - Verify: `core` (or `mcp`) — matrix table tests with an injected fake fs.
  - Files: `packages/core/src/auth/boot-credentials.ts`, its test, `packages/core/src/index.ts`.

- [ ] **D0.4 — Wire bootstrap into the server boot**
  - Acceptance: `bin/http.ts` calls `resolveBootCredentials` (replacing the raw
    `resolveOptionalSecretKey` + admin-token env reads); generation logs exactly once each; the
    admin-token print is the sole sanctioned token log; existing fatal-on-bad-key behavior preserved.
  - Verify: `mcp` suite green; manual: boot with empty env + temp dir → key+token files appear, logged
    once; reboot → no new generation; boot with env set → no files written.
  - Files: `packages/mcp-server/src/bin/http.ts` (+ `bin/stdio.ts` if it shares the key path).

- [ ] **D0.5 — Exclude credential files from backups** (TDD)
  - Acceptance: the backup bundle never includes `secret.key` / `admin.token` even though they live
    under the data dir; existing backup contents otherwise unchanged.
  - Verify: `core` — extend the backup module test to assert the two files are absent from a bundle
    seeded with them.
  - Files: `packages/core/src/backup/*.ts` (the bundle/file-collection module), its test.

- [ ] **D0.6 — Restore prompts for / accepts the master key** (TDD)
  - Acceptance: after a restore, if a secret setting fails to decrypt with the resolved key, the CLI
    reads `--secret-key` or prompts on a TTY, then retries; a correct key decrypts, a wrong key errors
    clearly; non-interactive + no flag → actionable error (not a stack trace).
  - Verify: `cli` — restore test with a key-mismatch fixture (flag path + injected-prompt path + wrong-key).
  - Files: `packages/cli/src/commands/restore.ts`, `packages/cli/tests/restore*.test.ts`.

- [ ] **D0.7 — Docs: auto-generation + restore key prompt**
  - Acceptance: `.env.example` marks `LIBRARIAN_SECRET_KEY` / `LIBRARIAN_ADMIN_TOKEN` as
    "auto-generated to the data volume if unset; set to manage yourself"; `DEPLOYMENT.md` documents the
    one-time log, the "save your key" warning, and the restore key prompt.
  - Verify: manual read-through; `pnpm format:check`.
  - Files: `.env.example`, `DEPLOYMENT.md`.

---

## D1 — Core auth-config + password (store-backed), env fallback

- [ ] **D1.1 — Password hash/verify** (TDD)
  - Acceptance: `setOwnerPassword(store, username, password)` stores `{username, salt, hash, N,r,p,
    updated_at}` as a **plain** setting (one-way); `verifyOwnerPassword` is timing-safe, enforces a
    length floor, rejects wrong username/password; params live in the record (future-proof).
  - Verify: `core` — `auth/password` set→verify / wrong-pw / wrong-user / length-floor.
  - Files: `packages/core/src/auth/password.ts`, `packages/core/tests/auth/password.test.ts`.

- [ ] **D1.2 — Lockout accounting** (TDD)
  - Acceptance: failures tracked at `auth:lockout` `{failures, firstFailureAt, lockedUntil}`; N=5 within
    a window → exponential lock; `verify` increments on miss, clears on success; lock persists across a
    fresh store handle; a reset clears it.
  - Verify: `core` — lockout trigger / persist / clear-on-success / reset.
  - Files: `packages/core/src/auth/password.ts`, `packages/core/tests/auth/password.test.ts`.

- [ ] **D1.3 — One-time setup links** (TDD)
  - Acceptance: `mintSetupLink(store, ttlMs)` → hashed single-use record `auth:setup_link:<id>`,
    returns plaintext once; `consumeSetupLink(store, token)` validates unexpired + unused + hash, marks
    used; replay/expiry rejected.
  - Verify: `core` — mint→consume once / replay rejected / expiry rejected.
  - Files: `packages/core/src/auth/password.ts`, `packages/core/tests/auth/password.test.ts`.

- [ ] **D1.4 — Auth-config read/write + AUTH_SECRET derivation** (TDD)
  - Acceptance: `getAuthConfig` returns `{enabled, methods, ownerOAuth, authSecret}` (OAuth secrets
    decrypted; `authSecret = hkdf(SECRET_KEY,"dashboard-jwt-v1")`, stable per key, changes with key);
    `setOAuth`/`setOwner`/`setEnabled` persist (OAuth secret `{secret:true}`); the config read never
    returns the password hash.
  - Verify: `core` — round-trip OAuth secret encrypted / authSecret stability / hash never exposed.
  - Files: `packages/core/src/auth/auth-config.ts`, `packages/core/tests/auth/auth-config.test.ts`,
    `packages/core/src/index.ts`.

- [ ] **D1.5 — `enableAuth(store, presentedAdminToken)`** (TDD)
  - Acceptance: timing-safe compare to the configured admin token; validates completeness (≥1 method +
    derivable secret) **before** persisting `enabled=true`; wrong/absent token or incomplete config →
    rejected, flag unchanged.
  - Verify: `core` — wrong token rejected / incomplete rejected / happy path flips flag.
  - Files: `packages/core/src/auth/auth-config.ts`, `packages/core/tests/auth/auth-config.test.ts`.

---

## D2 — `auth` tRPC router + dynamic dashboard config

- [ ] **D2.1 — `auth` tRPC router** (TDD)
  - Acceptance: `adminProcedure` router — `config`, `enable`, `disable`, `setPassword`,
    `configureOAuth`, `setOwner`, `verifyPassword`; mounted as `auth`; every mutation admin-gated
    (non-admin rejected); `enable` rejects a wrong admin token; `verifyPassword` honors lockout.
  - Verify: `mcp` — `trpc/auth.test.ts` (admin gating, enable-token check, verifyPassword lockout).
  - Files: `packages/mcp-server/src/trpc/auth.ts`, `packages/mcp-server/src/trpc/router.ts`,
    `packages/mcp-server/tests/trpc/auth.test.ts`.

- [ ] **D2.2 — Dashboard auth-config cache** (TDD)
  - Acceptance: `lib/auth-config-client.ts` fetches via the `auth.config` procedure, caches in-process
    with 30s TTL, exposes `bust()`; concurrent reads share one fetch; `bust()` forces a refetch.
  - Verify: `dashboard` — cache hit within TTL, refetch after TTL, refetch after `bust()` (injected clock + fetch spy).
  - Files: `apps/dashboard/lib/auth-config-client.ts`, `apps/dashboard/tests/auth-config-client.test.ts`.

- [ ] **D2.3 — Lazy NextAuth config from the store**
  - Acceptance: `auth.ts` uses the v5 lazy form, assembling providers + `secret` from the cached config
    (GitHub/Google only when creds present; `signIn` allowlist from config, not env); legacy env used as
    fallback when no store config exists. **Verify the v5 lazy/Credentials API via Context7 first.**
  - Verify: `dashboard` — `signIn` allowlist unit test still green against config input; build succeeds.
  - Files: `apps/dashboard/auth.ts`, `apps/dashboard/lib/owner-allowlist.ts` (accept config input).

- [ ] **D2.4 — Fail-closed enforcement from config** (TDD)
  - Acceptance: `middleware.ts`/`auth-gate.ts` read enforcement from the cache; `!enabled` → pass;
    `enabled && ok` → redirect unauth → `/login`; `enabled && !ok` (store unreachable/incomplete) →
    block to a store-independent page naming `the-librarian auth disable`; A2's `/api/trpc` proxy gate
    intact; env-fallback deploy still authenticates.
  - Verify: `dashboard` — outage-fails-closed test (mocked unreachable config), env-fallback test, proxy-gate regression test.
  - Files: `apps/dashboard/middleware.ts`, `apps/dashboard/lib/auth-gate.ts`,
    `apps/dashboard/tests/auth-gate.test.ts`.

---

## D3 — Password login

- [ ] **D3.1 — Credentials provider**
  - Acceptance: a Credentials provider whose `authorize()` calls `auth.verifyPassword`; success encodes
    the single-owner identity into the JWT consistently with the OAuth path; failure/lockout → no session.
  - Verify: `dashboard` — `authorize` returns owner on ok, null on fail/lockout (verifyPassword mocked).
  - Files: `apps/dashboard/auth.ts`, `apps/dashboard/tests/credentials-authorize.test.ts`.

- [ ] **D3.2 — Rate-limit the credentials route** (TDD)
  - Acceptance: dashboard-side throttle (defense in depth atop store-side lockout) on the credentials
    POST; bounded attempts per window; returns a generic error (no user/lockout enumeration).
  - Verify: `dashboard` — burst over the limit is throttled; under the limit passes.
  - Files: `apps/dashboard/app/api/auth/[...nextauth]/route.ts` (or a wrapper), its test.

- [ ] **D3.3 — Login form shows password when configured**
  - Acceptance: `/login` renders the operator-chosen-username + password fields only when a password
    method is configured (from cached config); OAuth buttons render per configured provider.
  - Verify: `dashboard` — component test: password method present → form shown; absent → hidden.
  - Files: `apps/dashboard/app/login/page.tsx`, `apps/dashboard/tests/login-page.test.tsx`.

- [ ] **D3.4 — Password login + lockout e2e**
  - Acceptance: sign in with password succeeds; N wrong attempts lock out; lock persists across a store
    restart; an OAuth method still works alongside.
  - Verify: `e2e` — `e2e/auth-password.spec.ts`.
  - Files: `apps/dashboard/e2e/auth-password.spec.ts` (+ test harness seeding).

---

## D4 — CLI recovery (`the-librarian auth …`)

- [ ] **D4.1 — Register `auth` command + `status`**
  - Acceptance: `auth` dispatches via the `sessions <verb>` pattern; `auth status` prints configured
    methods + enabled flag with **no secrets**; usage text added.
  - Verify: `cli` — `status` output shape; unknown verb → usage.
  - Files: `packages/cli/src/runtime.ts`, `packages/cli/src/commands/auth.ts`,
    `packages/cli/tests/auth-commands.test.ts`.

- [ ] **D4.2 — `auth reset-password` (inline/prompt)** (TDD)
  - Acceptance: `--password <pw>` or interactive prompt sets a new hash via `setOwnerPassword` and
    clears lockout; length floor enforced; success message names what changed.
  - Verify: `cli` — reset writes a verifiable hash + clears lockout (injected store).
  - Files: `packages/cli/src/commands/auth.ts`, `packages/cli/tests/auth-commands.test.ts`.

- [ ] **D4.3 — `--print-setup-link` + reset page**
  - Acceptance: `reset-password --print-setup-link` mints a 15-min one-time link (`mintSetupLink`) and
    prints the URL (configured origin or `--origin`); `/settings/auth/reset` consumes it
    (`consumeSetupLink`) → set password; link is single-use + expiring.
  - Verify: `cli` (link minted/printed) + `dashboard` (reset page consumes once, rejects reuse/expiry).
  - Files: `packages/cli/src/commands/auth.ts`, `apps/dashboard/app/settings/auth/reset/page.tsx`,
    `apps/dashboard/app/settings/auth/reset/actions.ts`, tests for each.

- [ ] **D4.4 — `auth disable` break-glass** (TDD)
  - Acceptance: `auth disable` sets `enabled=false`; takes effect on a running dashboard within the 30s
    cache TTL (documented); idempotent.
  - Verify: `cli` — flag flips; `dashboard` — enforcement off once cache expires (clock-injected).
  - Files: `packages/cli/src/commands/auth.ts`, `packages/cli/tests/auth-commands.test.ts`.

---

## D5 — Setup wizard UI

- [ ] **D5.1 — `/settings/auth` scaffold + nav + actions**
  - Acceptance: gated settings page + nav entry; `actions.ts` wraps the `auth` tRPC mutations and busts
    the config cache after each; page reads current config.
  - Verify: `dashboard` — actions call the right procedures + `bust()` (mocked trpc).
  - Files: `apps/dashboard/app/settings/auth/page.tsx`, `apps/dashboard/app/settings/auth/actions.ts`,
    `apps/dashboard/components/site-nav.tsx`, test.

- [ ] **D5.2 — Enable card (admin-token bootstrap)**
  - Acceptance: an "Enable authentication" card takes the admin token, calls `enable`, surfaces a
    wrong-token error, reflects enabled state; refuses if no method is configured yet.
  - Verify: `dashboard` — component test (success, wrong token, no-method guard).
  - Files: `apps/dashboard/components/settings/auth/enable-card.tsx`, its test.

- [ ] **D5.3 — Password setup form**
  - Acceptance: choose username + password (+ confirm), client length check, calls `setPassword`,
    shows saved state; never echoes the password back from the server.
  - Verify: `dashboard` — component test (validation + submit).
  - Files: `apps/dashboard/components/settings/auth/password-form.tsx`, its test.

- [ ] **D5.4 — OAuth wizard**
  - Acceptance: per provider — display the exact callback URL `<origin>/api/auth/callback/{github,google}`,
    paste client id/secret → `configureOAuth`, then a "verify by signing in" affordance; secrets never
    rendered back.
  - Verify: `dashboard` — component test (callback URL shown, save calls procedure).
  - Files: `apps/dashboard/components/settings/auth/oauth-wizard.tsx`, its test.

- [ ] **D5.5 — Methods/owner list + disable control**
  - Acceptance: lists configured methods + owner identities (no secrets); a disable control calls
    `disable` with confirmation.
  - Verify: `dashboard` — component test (renders methods, disable confirm path).
  - Files: `apps/dashboard/components/settings/auth/methods-panel.tsx`, its test.

- [ ] **D5.6 — Docs + full wizard e2e**
  - Acceptance: `.env.example`/`DEPLOYMENT.md` mark the A1–A5 auth env vars deprecated/optional and
    document the wizard; Playwright covers open → enable → set password → enforce → login →
    wrong-password lockout → (simulated) CLI reset → login, plus the OAuth happy path with a mocked
    provider.
  - Verify: `e2e` — `e2e/auth-setup.spec.ts`; `pnpm format:check`.
  - Files: `apps/dashboard/e2e/auth-setup.spec.ts`, `.env.example`, `DEPLOYMENT.md`.

---

## Parallelization notes

- D0 and D1 are both pure-core and could be worked concurrently, but D0 lands first (it's
  independently shippable and de-risks the key-availability assumption D1 relies on).
- After D2, **D3 and D4 are independent** (D3 = dashboard login; D4 = CLI + the reset page) and can run
  in parallel. **Sequencing safety:** D4 must merge before D3's enforcement is exposed anywhere.
- D5 depends on all of D0–D4.

## Count / sizing

29 tasks across 6 slices; each touches ≤5 files and is sized for a single focused session. Estimated
PR mapping: one PR per slice (D0–D5), tasks as commits within.

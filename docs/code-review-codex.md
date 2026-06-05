# Codex Code Review

Date: 2026-06-05

Scope note: this review is against the currently checked-out local tree in
`/Users/jim/code/the-librarian`. The checkout is on `main` and is behind
`origin/main` by 171 commits, so some findings may already be changed upstream.

> **Discarded as out-of-date (2026-06-05 merge step):** verified against current
> `main`, findings **#2, #6, #7, #11, #14** targeted subsystems that have since
> been deleted (SQLite `projection.ts` + JSONL ledger, the `domain` model, the
> `classifier` package) and were **removed** below — the surviving findings keep
> their original numbers, so the gaps are intentional. The live findings were
> reconciled into
> [`code-review-merged-2026-06-05.md`](./code-review-merged-2026-06-05.md).

Severity scores are 1-100 and combine privacy/security impact, exploitability,
likelihood, user impact, and maintenance drag. Fix estimates are my estimates
for me to implement and verify, not human estimates.

## Findings

### 1. Credentialed outbound fetches do not fail closed on redirects

- Severity: 94/100
- Estimated fix time: 0.5-1 hour
- Evidence:
  - `packages/core/src/curator-llm-client.ts:129-137` sends
    `Authorization: Bearer ...` to an arbitrary OpenAI-compatible endpoint
    without `redirect: "error"`.
  - `packages/mcp-server/src/github-release.ts:67-70` sends
    `LIBRARIAN_GITHUB_TOKEN` without redirect control.
  - `scripts/healthcheck.js:380-384` sends an agent bearer token to `/mcp`
    without redirect control.
- Why it matters: project rules say bearer tokens never go in URLs/logs/error
  messages and every outbound HTTPS call carrying credentials must use
  `redirect: "error"`. Default fetch redirect behavior can forward headers in
  ways operators do not expect, especially with configurable LLM endpoints.
- Suggested fix: add `redirect: "error"` to the LLM client, GitHub release
  checker, and healthcheck credentialed fetches. Add tests that inject a fake
  fetch and assert redirect mode is set for credentialed requests.

### 3. Dependency audit currently includes one critical and three moderate vulnerabilities

- Severity: 88/100
- Estimated fix time: 1-2 hours
- Evidence:
  - `pnpm audit --audit-level high` reported:
    - critical: Vitest `<4.1.0` (`GHSA-5xrq-8626-4rwp`)
    - moderate: esbuild `<=0.24.2` (`GHSA-67mh-4wv8-2f99`)
    - moderate: Vite `<=6.4.1` (`GHSA-4w7w-66w2-5vf9`)
    - moderate: PostCSS `<8.5.10` through Next (`GHSA-qx2v-qp2m-jg93`)
  - `pnpm-workspace.yaml:5-7` pins the shared Vitest catalog to `^2.1.8`.
  - `apps/dashboard/package.json:27` pins Next to `^15.1.4`.
- Why it matters: some of this is dev/test tooling, but this repo runs agentic
  workflows over untrusted diffs and CI artifacts, so a critical test-runner
  advisory is not just cosmetic.
- Suggested fix: upgrade Vitest/Vite/esbuild together and run the full suite.
  Upgrade or override the Next/PostCSS path after checking Next compatibility.

### 4. Fresh admin tokens are printed into boot logs

- Severity: 86/100
- Estimated fix time: 1-1.5 hours
- Evidence:
  - `packages/mcp-server/src/bin/http.ts:63-68` logs the generated admin token
    value.
  - `packages/core/src/auth/admin-token.ts:8-11` documents the token as a
    bearer secret but still allows the one-time log notice.
  - `.env.example:6-13` and `README.md:125-128` tell operators to watch logs
    for one-time values.
- Why it matters: this contradicts the repo's "tokens never appear in logs"
  rule. It also makes first boot logs a sensitive artifact in container hosts,
  process managers, and managed logging.
- Suggested fix: stop printing the token value. Prefer a local-only retrieval
  command or explicit setup link stored in the data volume with mode 0600. If
  compatibility requires keeping this behavior briefly, gate it behind an
  explicit opt-in env var and document the risk.

### 5. Open dashboard mode proxies admin API power to anyone who can reach the dashboard

- Severity: 83/100
- Estimated fix time: 1.5-2.5 hours
- Evidence:
  - `apps/dashboard/app/api/trpc/[trpc]/route.ts:39-43` skips session checks
    when enforcement is `"open"`.
  - `apps/dashboard/app/api/trpc/[trpc]/route.ts:53-59` then injects
    `LIBRARIAN_ADMIN_TOKEN` and proxies the request upstream.
  - `apps/dashboard/tests/trpc-proxy-gate.test.ts:99-107` pins this behavior as
    backwards-compatible.
  - `packages/mcp-server/src/trpc/auth.ts:31-33` returns decrypted OAuth config
    and the derived auth secret through the admin-gated API.
- Why it matters: docs warn that dashboard network access is admin access, so
  this is not accidental. Still, it is a sharp setup-mode window: any exposed
  dashboard before enforcement is enabled can mutate admin state through the
  proxy.
- Suggested fix: keep open read/setup UX if needed, but require an admin-token
  presentation or setup nonce for mutating/admin-secret procedures until auth is
  enabled. At minimum, split safe setup calls from general admin tRPC.

### 8. Docker quick start contradicts Docker Compose's required admin token

- Severity: 72/100
- Estimated fix time: 0.5-1 hour
- Evidence:
  - `README.md:120-128` says Docker setup needs zero auth/secret env vars and
    the `.env` copy is optional.
  - `docker/docker-compose.yml:24` and `docker/docker-compose.yml:57` require
    `LIBRARIAN_ADMIN_TOKEN` or Compose refuses to start.
  - `.env.example:6-13` labels the admin token optional/auto-generated, but the
    two-container Compose topology cannot automatically share a generated token
    from the MCP container into the dashboard container.
- Why it matters: README install commands are a contract. The current path
  likely fails for a fresh operator before the app ever boots.
- Suggested fix: either update README/.env.example to require an explicit token
  for two-container Docker, or provide a working zero-env topology where both
  services share a generated credential safely.

### 9. `/mcp` bearer auth lacks throttling, and public `/healthz` leaks auth posture

- Severity: 68/100
- Estimated fix time: 1-2 hours
- Evidence:
  - `packages/mcp-server/src/http/routes.ts:43-50` returns auth posture fields
    from unauthenticated `/healthz`.
  - `packages/mcp-server/src/http/routes.ts:59-70` calls `authenticateMcp`
    directly and rejects bad bearer tokens with no rate limiting.
  - `packages/mcp-server/src/http/auth.ts:30-49` verifies bearer tokens.
  - `docs/TODO.md:10-20` already lists both hardening items.
- Why it matters: the health data is not catastrophic, but it is unnecessary
  reconnaissance. The no-throttle bearer surface is a real online guessing gap,
  especially for long-lived deployed endpoints.
- Suggested fix: keep public `/healthz` to `{ "status": "ok" }`, move posture
  detail behind admin auth, and add a small per-IP/token-prefix rate limiter for
  failed `/mcp` auth attempts.

### 10. Auth-enforced dashboard e2e coverage is still missing

- Severity: 60/100
- Estimated fix time: 2-3 hours
- Evidence:
  - `docs/TODO.md:36-42` says enforcement-on Playwright coverage remains open.
  - `apps/dashboard/tests/trpc-proxy-gate.test.ts:50-107` covers the proxy gate
    branch at unit level, but not browser navigation, redirects, cookies, or the
    full dashboard/server interaction.
- Why it matters: the auth gate is one of the highest-risk surfaces in this
  repo. Unit tests are useful, but the dangerous regressions here are usually
  integration mistakes across middleware, route handlers, Auth.js, and tRPC.
- Suggested fix: add a dedicated Playwright project/server configured with
  enforcement on and cover unauthenticated redirect, authenticated dashboard
  access, and admin tRPC denial without a session.

### 12. Dashboard build emits runtime-configuration warnings during static generation

- Severity: 45/100
- Estimated fix time: 0.5 hour
- Evidence:
  - `apps/dashboard/lib/trpc-server.ts:16-27` writes warnings at module import
    time when `LIBRARIAN_SERVER_URL` or `LIBRARIAN_ADMIN_TOKEN` are unset.
  - `pnpm run build` passed, but Next static generation printed these warnings
    repeatedly.
- Why it matters: noisy build logs train operators to ignore real warnings. It
  also makes CI output look misconfigured even when static generation is not
  expected to talk to the runtime server.
- Suggested fix: move these warnings behind a runtime-only once guard, or emit
  them from the actual server action path that needs the configuration.

### 13. Dashboard has dead dependency and UI utility cruft

- Severity: 42/100
- Estimated fix time: 0.5-1 hour
- Evidence:
  - `pnpm dlx knip --reporter compact` reported unused dashboard deps/exports.
  - `apps/dashboard/lib/utils.ts:1-5` defines `cn`, and `rg` found no call sites.
  - `apps/dashboard/package.json:18,24-25,33` includes
    `@radix-ui/react-slot`, `class-variance-authority`, `clsx`, and
    `tailwind-merge`; the latter two are only used by the unused utility.
  - `apps/dashboard/components/ui-v2/dialog.tsx:102-107` exports Radix pieces
    that are not imported elsewhere in the repo.
- Why it matters: individually small, but this is exactly the kind of
  generated-design-system residue that makes future UI work feel larger than it
  is.
- Suggested fix: remove the unused utility and dependencies after confirming no
  public package surface depends on them. Keep the dialog exports only if they
  are deliberately part of a local component API.

### 15. Stale comments still describe pre-current behavior

- Severity: 34/100
- Estimated fix time: 0.5 hour
- Evidence:
  - `apps/dashboard/auth.ts:11` says the Credentials provider and login form
    land in D3, but the file already imports and registers `Credentials` at
    `apps/dashboard/auth.ts:13-49`.
  - Several memory-domain comments still refer to future PR phases after the
    related code has landed, e.g. `packages/core/src/schemas/memory.ts:59-66`
    says subsequent PRs will tighten fields that are already used across the
    dashboard/MCP surface.
- Why it matters: this codebase has a lot of important historical comments.
  When stale comments sit next to security-sensitive auth/domain logic, future
  maintainers lose confidence about which comments are load-bearing.
- Suggested fix: do a comment-only cleanup pass near auth and memory-domain
  code. Keep rationale comments, remove obsolete schedule/phase claims.

## Checks run

- `git status --short --branch`
  - Result: clean checkout on `main`, behind `origin/main` by 171 commits.
- `pnpm run typecheck`
  - Result: passed.
- `pnpm run lint`
  - Result: passed.
- `pnpm run check:schema-version`
  - Result: passed.
- `pnpm run check:classifier-env-retirement`
  - Result: passed.
- `pnpm run check:test-count`
  - Result: passed after rerunning Vitest outside the sandbox because the root
    Vitest run needed local port binding.
- `pnpm -r run test:vitest`
  - Result: passed outside the sandbox. Package summaries showed 929 tests
    passing across core, classifier, classifier-eval, mcp-server, cli, and
    dashboard.
- `pnpm -r run build`
  - Result: passed. Dashboard build emitted repeated runtime-config warnings
    covered above.
- `pnpm audit --audit-level high`
  - Result: failed with one critical and three moderate advisories, covered
    above.
- `pnpm dlx knip --reporter compact`
  - Result: found unused files/dependencies/exports. Some output is expected
    false positive for entrypoints and public exports; the dashboard cruft
    above was independently checked with `rg`.

## Residual risk

I did not run the Playwright e2e suite or the smoke/healthcheck scripts during
this review. The unit/build/type/lint coverage is strong, but the highest-risk
remaining verification gap is still browser-level auth enforcement and setup
flow coverage.

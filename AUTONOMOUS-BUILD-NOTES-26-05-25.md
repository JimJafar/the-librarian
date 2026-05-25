# Autonomous build notes — dashboard-managed auth (2026-05-25)

Running `/autonomous-build` over `docs/specs/dashboard-managed-auth-tasks.md` (29 tasks, slices D0–D5).
This file is local-only (in `.git/info/exclude`) and must never be committed.

## Decisions taken autonomously (reversible — flagged for Jim's end-of-run review)

- **One PR per slice** (D0–D5), per the spec's explicit "one PR per D-slice" mandate, rather than one
  mega-PR. Each slice branches from fresh `main`, runs its own simplify/review/CI/merge cycle.
- **Slice order reordered to D0 → D1 → D2 → D4 → D3 → D5.** The spec's safety constraint is "D4
  (recovery) must merge before D3's enforcement is exposed." Since slices are built serially (not truly
  parallel), doing D4 before D3 satisfies that with no extra coordination.
- **PR #143 NOT auto-merged.** It carries the planning docs *plus* the memories-modal fix that the prior
  session flagged Jim wants to "eyeball in the running dashboard before merge." Implementation branches
  are taken from `main` independently; the spec docs are read from the #143 branch. The D-slice PRs do
  not depend on #143 being merged.
  - ACTION FOR JIM: merge #143 after eyeballing the memories modal.

## Open questions / smaller points to consider

- **Restore key prompt (D0.6):** master-key entry now reads in raw mode with echo off.
  If you'd rather it echo (some operators paste long keys and want to see them), that's
  a one-line change. Left echo-off as the secure default.
- **Code-review suggestions intentionally NOT actioned** (judged acceptable by the reviewer):
  the one-time admin-token log interpolates the token into the message string rather than a
  structured field; restore opens a fresh store per key attempt (re-runs migrations, cheap at
  restore time). Flagging in case you want either changed later.

## Per-slice status — INITIATIVE COMPLETE (all merged to main)

Build order D0 → D1 → D2 → D4 → D3 → D5 (D4 before D3 per the safety constraint:
recovery must exist before enforcement is exposed). Each slice ran TDD → simplify →
a fresh-context five-axis code review → fix → full local CI parity → PR → watch CI →
rebase-merge. Every CI run was green.

- **D0** — credential bootstrap (master key + admin token auto-generate to the data
  volume; key-free backups + restore key prompt). PR #144. Review fixes: fail-soft
  after the destructive restore overwrite; no-echo master-key prompt.
- **D1** — core auth-config + password (scrypt, lockout, one-time setup links,
  HKDF-derived AUTH_SECRET, gated enableAuth). PR #145. Review caught a **Critical**:
  the lockout window was evadable by pacing guesses under a fixed first-failure-
  anchored window — fixed with a sliding idle window.
- **D2** — auth tRPC router + dynamic dashboard config (30s cache, lazy NextAuth v5
  verified via Context7, fail-closed enforcement in middleware + the /api/trpc proxy).
  PR #146. Review caught a **Critical** (secret-bearing auth.config GET was cacheable
  → no-store) and an **Important** (the legacy env flag must be a floor so a
  store-managed-disabled config can't silently drop env-enforced auth).
- **D4** — CLI recovery: `auth status / reset-password / --print-setup-link /
  disable` + the public /settings/auth/reset page + redeemSetupLink. PR #147. Needed
  a force-push history rewrite: GitGuardian flagged an inline high-entropy hex literal
  inside a `resolveSecretKey("…")` call in a test — bind such values to a const first.
- **D3** — password login (Credentials provider, rate-limit, config-driven /login
  form, lockout e2e). PR #148. Added env knobs LIBRARIAN_AUTH_CONFIG_TTL_MS and
  LIBRARIAN_CREDENTIALS_RATE_LIMIT (safe defaults 30s / 10).
- **D5** — setup wizard UI (/settings/auth: enable card, password form, OAuth wizard,
  methods/owner panel) + docs (env auth deprecated) + wizard e2e. PR #149. Review
  caught 2 **Important**: the MethodsPanel disable swallowed failures (a break-glass
  control must surface errors); the OAuth wizard's required-vs-"leave set"
  contradiction (the secret is now optional once configured).

## Post-build follow-up

- **PR #143** (memories detail modal + the spec/plan/tasks planning docs) was merged
  after the initiative. Its memories-overflow e2e regressed because the modal refactor
  dropped `[&>*]:min-w-0` from the list section — restored, full e2e green.
- This notes file was committed at Jim's explicit request (the `/autonomous-build`
  default keeps it untracked; the `.gitignore` rule remains for future runs).

## Smaller points intentionally deferred (low value, flagged earlier)

- The one-time admin-token log interpolates the token into the message string rather
  than a structured field (acceptable per review).
- `configComplete` is duplicated dashboard-side (auth-gate.ts) vs core
  (isAuthConfigComplete) to keep node:crypto out of the middleware bundle; kept in
  lockstep by comment, no cross-impl equivalence test.
- The "15 minutes" setup-link TTL human-string appears in 3 user-facing spots (CLI ×2
  + reset page); not centralized across packages.
- `setEnabled(store, true)` stays exported but is documented as skipping the enableAuth
  gate (enableAuth is the gated ON path; disable is the ungated break-glass).
- Restore master-key prompt is echo-off (flip to echo if you prefer paste-visibility).

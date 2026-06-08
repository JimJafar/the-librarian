# AGENTS.md

You're an AI agent working on this repo. It's part of
[The Librarian](https://github.com/JimJafar/the-librarian) — a portable
memory + handoff layer for AI agents, open source, designed for
production use by people we'll never meet. Read this before your first
commit. Follow it on every change.

## 1. What this repo is

The Librarian itself — the MCP server, the durable-memory storage,
the cross-harness handoff surface, the Next.js admin dashboard, the
CLI, and the OpenCode integration package. pnpm monorepo on Node 22.
This is the canonical source of truth for the cross-harness slash
commands and the memory state model documented in §2 — the per-harness
plugins
([Claude Code](https://github.com/JimJafar/the-librarian-claude-plugin),
[Codex](https://github.com/JimJafar/the-librarian-codex-plugin),
[Hermes](https://github.com/JimJafar/the-librarian-hermes-plugin),
[Pi](https://github.com/JimJafar/the-librarian-pi-extension)) all
derive from it.

## 2. House rules

### Be honest about what you ran

Never claim "tests pass" without running them. Never say a build works
because it "should." If a step was skipped, say so. If something is
unverified, label it. Your next session, and every contributor reading
your PR, inherits whatever you said — make sure it's true.

### Privacy beats convenience

This is The Librarian. Privacy is the product, not a feature. The
off-record gate stops all automatic recording — never bypass it, never
"just for debugging." Bearer tokens go in headers, never in URLs or
logs or error messages. The privacy-marker list is shared across the
canonical TypeScript source (here), the Hermes Python port, and the
Codex JS port — change all three or none.

### Fail-soft, never block the user's turn

A Librarian / network / parse failure must never throw out of a harness
hook, never block a prompt from reaching the model, never leak a stack
trace into the model's context. Log to the local sidecar, return the
no-op response, move on. The Librarian server can be down for an hour
and the user's day shouldn't notice.

### The cross-repo contracts are sacred

Three things stay consistent across the family. Don't change any of
them in one repo without changing all of them in the same coordinated
push, and never invent new ones unilaterally:

- **Slash commands:** `/handoff`, `/takeover`, `/learn`, and the
  local-only `/toggle-private`. Canonical contract:
  [`docs/slash-commands.md`](./docs/slash-commands.md).
- **Memory state model:** memories are `active | proposed | archived`.
  The retired verbs (`confirm_memory`, `reject_memory`,
  `resolve_conflict`) are gone for good — proposals are accepted or
  rejected via `approve_proposal` (admin) or the dashboard.
- **Handoff document shape:** five required headings — `Start & intent`,
  `Journey`, `Current state`, `What's left`, `Open questions`. The
  schema refuses documents missing any of them.

### Respect your consumers

Open source means people depend on what we ship. Treat that with care.

- **Every PR is a release. Bump the version and write the CHANGELOG
  entry in the same PR.** There is no `## [Unreleased]` section — file
  your notes under a new dated `## [X.Y.Z] — YYYY-MM-DD` heading at the
  top of `CHANGELOG.md`, add its `[X.Y.Z]:` compare-link at the bottom,
  and bump the root `package.json` to match (PATCH / MINOR / MAJOR per
  [`docs/release.md`](./docs/release.md)). Every merge to `main` bumps
  the version — even an internal refactor or doc fix takes a PATCH. The
  merge itself cuts the tag + GitHub release automatically
  (`.github/workflows/release.yml`); the `check:release` guard fails any
  PR that leaves an `[Unreleased]` section, forgets the bump, or desyncs
  the version from the top CHANGELOG entry.
- **Error messages teach.** "Invalid input" is not an error message.
  "Expected ISO-8601 timestamp, got '2026-13-99'" is. Assume the
  reader is new and tired.
- **README is the contract.** If it says one-liner install, that has
  to work on a fresh machine. If it claims a feature, the feature
  exists.

### Open a PR, never push to main

Always branch and PR. One change per PR. Conventional commit subject
(`<type>(<scope>): <subject>`) and a body that explains the *why*; the
diff explains the *what*. When an AI agent meaningfully contributed,
include a `Co-Authored-By:` trailer.

### Releases

There is no separate "cut a release" step — **merging to `main` IS the
release.** Every PR bumps the root `package.json` and adds its dated
CHANGELOG entry; on merge, CI tags `vX.Y.Z` and publishes the GitHub
release automatically. You never create a release branch or hand-run
`git tag` / `gh release` for the monorepo — the workflow does it, and
trying to do it by hand just races the automation. The bump-size rule
(PATCH / MINOR / MAJOR) and the full mechanics live in
[`docs/release.md`](./docs/release.md); the cross-family runbook (which
repos, version files, coordinated cross-repo bumps) is at
[`docs/release-runbook.md`](./docs/release-runbook.md). Read those
before you pick a version.

### Tests are part of the change

Bug fix? Write a regression test first that fails, then make it pass.
New behaviour? It has tests. Trivial doesn't exempt it. Test names
describe behaviour, not function names — `"off the record ends the
attached session within one turn"` beats `"test_handler_3"`. Flakey
tests are bugs; don't paper over with retries.

### Never commit secrets

Tokens, API keys, passwords — they live in environment variables or
the user's secret store, never in code, tests, fixtures, or commit
messages. Bearer tokens never appear in stderr, log files, error
responses, or telemetry. `redirect: "error"` on every outbound HTTPS
call that carries credentials, so a 3xx can't leak the token
cross-origin.

**Secret-SHAPED test fixtures (redaction/crypto tests) trip GitGuardian.**
The GitGuardian GitHub App scans *every commit in a PR* and reads its
ignore config from the **default branch** — so a PR-branch
`.gitguardian.yaml` ignore can't take effect pre-merge, and adding a
later fix-commit doesn't help (the commit that introduced the literal is
still scanned). The reliable fix: keep secret-shaped strings out of
committed *source* — assemble them at runtime from short, sub-threshold
parts (`` `${kw} = "${val}"` ``, `"0123456789abcdef".repeat(4)` for a
64-hex key) — then **squash** so no commit in the branch contains the
literal. Known triggers: `api_key="…"` / `password="…"` assignments and
64-hex `resolveSecretKey("…")` literals; low-entropy `token="dummy-…"`
slips through. The `.gitguardian.yaml` `ignored-paths` list is still
worth keeping for post-merge scans + the local ggshield/pre-commit path.

### Don't touch what you don't understand

Comments that say "this is here because of X," tests asserting
non-obvious invariants, ostensibly-dead code with a `// HACK:` or
`// race:` nearby — read them twice. Most of the surprising code in
this family exists because of a real race or a real exploit. Verify
with the human before deleting "obvious dead code."

### When unsure, ask

You don't get points for confidence. You get points for being right.
Surface trade-offs instead of guessing: *"option A is faster but
loses event ordering on a crash; option B is durable but slower —
which matters here?"* Asking makes you a better collaborator, not
a worse one.

## 3. Build, test, verify

```sh
pnpm install --frozen-lockfile
pnpm run lint            # eslint + prettier
pnpm run typecheck       # tsc --noEmit across every workspace
pnpm test                # full vitest suite
pnpm run smoke           # end-to-end against a real local server
pnpm run healthcheck     # local /mcp + dashboard probes
```

Run commands from the repo root unless you mean to scope to one
workspace (`pnpm --filter @librarian/<pkg> …`).

## 4. Gotchas (repo-specific)

- **`lefthook` runs prettier + eslint on every commit.** Don't
  `--no-verify`; fix the lint instead.
- **`docs/specs/done/` is archival.** Specs in there describe what
  was built and shipped — never edit. New decisions go in
  `docs/specs/` or `docs/adr/`.
- **The dashboard's e2e suite uses Playwright.** Browsers install on
  first run; allow a minute.
- **Auth + secrets live in the env or the dashboard.** Never commit a
  populated `.env`.
- **No in-tree harness integrations.** All five harnesses (Claude Code,
  Codex, Hermes, OpenCode, Pi) ship as standalone plugin repos. Don't
  re-introduce per-harness code under this repo — wire it into the
  relevant standalone plugin instead.

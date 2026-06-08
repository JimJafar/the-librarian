# The Librarian — release runbook

How we cut releases across the six repos. Pragmatic. Trunk-based. No release branches.

**The model: merging to `main` IS the release.** Every PR bumps its repo's
version file(s) and files a dated `## [X.Y.Z]` CHANGELOG entry in the **same
PR** — there is no `[Unreleased]` section and no separate "cut a release" PR.
On merge, each repo's `.github/workflows/release.yml` tags `vX.Y.Z`, publishes
the GitHub release from the CHANGELOG section, and (for the npm packages)
publishes to npm — automatically. A `release-guard` CI job blocks any PR that
forgets the bump or leaves an `[Unreleased]` section. You never hand-run
`git tag` / `gh release` / `npm publish`.

The monorepo's own per-repo guide is [`docs/release.md`](./release.md); the
mechanics are identical in every repo.

## Repos at a glance

| Repo | Version file(s) | How users update | npm? |
|---|---|---|---|
| `the-librarian` | root `package.json` | `docker compose ... up -d` (deploy is automatic on merge) | — |
| `the-librarian-claude-plugin` | `package.json` + `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json` (`.plugins[].version`) | `/plugin update the-librarian` in Claude Code | — |
| `the-librarian-codex-plugin` | `package.json` + `plugins/the-librarian/.codex-plugin/plugin.json` | `codex plugin add the-librarian@the-librarian-codex` (re-add; refresh first with `codex plugin marketplace upgrade the-librarian-codex`) | — |
| `the-librarian-hermes-plugin` | **`plugin.yaml` `version`** (no `package.json`) | `hermes plugins update the-librarian-hermes-plugin` | — |
| `the-librarian-opencode-plugin` | `package.json` | `opencode plugin update the-librarian-opencode-plugin` | **npm** |
| `the-librarian-pi-extension` | `package.json` | `pi update the-librarian-pi-extension` | **npm** |

Every repo has the `release.yml` + `release-guard` automation. There is **no**
`codex plugin update` / `codex plugin path` command — Codex updates by re-adding.

## Branching strategy

Trunk-based on `main`. Same model in every repo.

- Feature branch off `main` → PR → merge. Never push to `main` directly.
- One change per PR. Conventional commit subject (`feat(scope): …`, `fix(scope): …`, `refactor(scope): …`).
- **Bump the version and add the dated CHANGELOG entry in the feature PR itself.** No `[Unreleased]` section; no long-lived release branches. The merge is the release.
- Plugin repos are sibling repos to the monorepo, not submodules. Cross-cutting changes (like sessions-rethink) get coordinated by landing the monorepo PR first, then a matching PR in each affected plugin.

## Semver

- **MAJOR** — breaking change to the MCP tool surface, the slash-command contract, the `source_ref` shape, the projection schema in a way that breaks an in-place upgrade, or any user-visible behaviour that needs a CHANGELOG migration note.
- **MINOR** — new MCP tool, new slash command, new dashboard surface, additive schema bump (drop-and-rebuild memory side is additive — events.jsonl is canonical), new env var with a default.
- **PATCH** — bug fix, doc tweak, internal refactor, test-only change, CI change.

Pre-1.0 (we are at 0.x), MINOR bumps are allowed to carry small breaking changes — but only if the CHANGELOG entry calls them out under `### Removed` or `### Changed`. Once we hit 1.0, breaking changes need a MAJOR.

## Trigger: every merge bumps

There is no "does this PR need a release?" judgement call. **Every merge to `main` bumps the version** (PATCH at minimum) and ships a dated CHANGELOG entry — including internal refactors, test-only changes, CI changes, and doc nits. This removes the failure mode where a change landed on `main` with an `[Unreleased]` note and the version bump was forgotten as a "later" step.

- The bump *size* still follows Semver above (most internal changes are a PATCH).
- A coordinated cross-repo change bumps every affected repo to **the same MINOR**.

When unsure about size, round down to PATCH — a tag and a GitHub release are free, and users who don't upgrade aren't affected.

## Versioning across the family

Plugin versions track the monorepo loosely, not strictly. A monorepo MINOR bump that doesn't change the MCP surface doesn't force every plugin to bump. But a coordinated cross-repo change (like sessions-rethink) should land with **the same MINOR version** across every affected repo, so an operator looking at the dashboard's version badge and the plugin marketplace entries sees the same number everywhere.

---

## How a release happens (every repo)

In your feature PR:

1. **Bump the version file(s)** for the repo (see the table above) — PATCH / MINOR / MAJOR per Semver.
2. **Add a dated `## [X.Y.Z] — YYYY-MM-DD` section** at the top of `CHANGELOG.md` and its `[X.Y.Z]:` compare-link at the bottom. (No `[Unreleased]` — the `release-guard` job enforces this, and that the version files agree with each other and with the top CHANGELOG entry.)
3. **Open the PR, get CI green, merge.**

On merge, `release.yml` reads the version, and if `vX.Y.Z` isn't tagged yet:

- creates the annotated `vX.Y.Z` tag and the GitHub release (notes = your CHANGELOG section);
- **opencode / pi only:** runs `npm publish --provenance` (inline). A tag pushed by the workflow's `GITHUB_TOKEN` does **not** trigger the tag-listening `publish.yml`, so the publish happens in `release.yml`. `publish.yml` is kept for manual recovery (`workflow_dispatch`) and any hand-pushed tag.

It is idempotent: a merge whose version is already tagged is a clean no-op.

### Per-repo notes

- **Monorepo** — the Docker image rebuilds via CI; deploy is automatic on merge. The dashboard version badge compares the running `package.json` to the latest GitHub release, refreshing on its 1-hour cache (restart the server for an immediate update).
- **Claude** — three version files must agree (`package.json`, `.claude-plugin/plugin.json`, and the `the-librarian` entry in `marketplace.json`); the guard checks this.
- **Hermes** — the version lives only in `plugin.yaml`. (v0.3.0 once shipped with `plugin.yaml` left at `0.2.0`; the guard now makes that impossible — the top CHANGELOG entry must equal `plugin.yaml`'s `version`.)
- **OpenCode / Pi (npm)** — needs the repo secret `NPM_TOKEN` (npm Automation token, read-and-write). Before a risky change to what ships, sanity-check the tarball with `npm pack --dry-run`; the `files` field in `package.json` is the gate. If an `npm publish` fails after the tag exists, re-run it via `publish.yml`'s `workflow_dispatch` (npm won't let you republish the same version, so never bump just to "force" a republish).

---

## Coordinated cross-repo release

When a change spans the monorepo and one or more plugins (the sessions-rethink rollout is the canonical example):

1. **Monorepo first.** The plugins talk to the server — never ship a plugin that depends on an MCP tool the deployed server doesn't have yet. (The monorepo PR's merge auto-releases it.)
2. **Then each affected plugin**, in any order — open a bump PR in each and merge. The four marketplace-style plugins (Claude / Codex / Hermes / Pi) are independent; opencode's npm publish lands a few minutes behind with no consequence.
3. **Use the same MINOR version** across the family for the coordinated bump. PATCH numbers can drift freely between repos.

If the change is **breaking** for the MCP surface (a tool renamed or removed), add a CHANGELOG note in the monorepo's release that names the minimum plugin version compatible with it.

---

## Release-day checklist (copy-paste)

Same in every repo — there is no separate release step:

- [ ] In your feature PR, bump the repo's version file(s) (see the table) — PATCH / MINOR / MAJOR
- [ ] Add `## [X.Y.Z] — YYYY-MM-DD` at the top of `CHANGELOG.md` + its `[X.Y.Z]:` compare-link (no `[Unreleased]`)
- [ ] `node scripts/check-release.mjs` passes locally (also enforced by the **release-guard** CI job)
- [ ] CI green → merge. `release.yml` tags + publishes the GitHub release (+ npm for opencode/pi) automatically.
- [ ] Verify the GitHub release appeared (and, for opencode/pi, `npm view <pkg> version` reports the new version)

For a coordinated cross-repo release: merge the monorepo PR first, then the plugin PRs in any order. Same MINOR version across all of them.

# The Librarian — release runbook

How we cut releases across the six repos. Pragmatic. Trunk-based. No release branches.

**The model: merging to `main` IS the release.** Every PR bumps its repo's
version file(s) and files a dated `## [X.Y.Z]` CHANGELOG entry in the **same
PR** — there is no `[Unreleased]` section and no separate "cut a release" PR.
The monorepo automates the tag + GitHub release on merge (see
[`docs/release.md`](./release.md)); the plugin repos are migrating to the same
automation and run the manual tag/release steps below until they have it.

## Repos at a glance

| Repo | Artifact | Version source | Install path | Auto-release on merge? |
|---|---|---|---|---|
| `the-librarian` | Docker image, GitHub release | root `package.json` | `docker compose ... up -d` | ✅ yes (`release.yml`) |
| `the-librarian-claude-plugin` | GitHub tag/release | `.claude-plugin/plugin.json` **and** `.claude-plugin/marketplace.json` | `/plugin marketplace add` | ⏳ migrating — manual |
| `the-librarian-codex-plugin` | GitHub tag/release | `.codex-plugin/plugin.json` **and** `package.json` | `codex plugin marketplace add` | ⏳ migrating — manual |
| `the-librarian-hermes-plugin` | GitHub tag/release | **`plugin.yaml` `version`** | `hermes plugins install <git>` | ⏳ migrating — manual |
| `the-librarian-opencode-plugin` | **npm** package + GitHub release | `package.json` | `opencode plugin install` (npm-backed) | ⏳ migrating — manual |
| `the-librarian-pi-extension` | GitHub tag/release | `package.json` | `pi install git:...` | ⏳ migrating — manual |

Only **opencode** needs `npm publish`. The other four plugins ship by git tag — the marketplace clients (Claude / Codex) and CLI installers (Hermes, Pi) pull straight from GitHub.

## Branching strategy

Trunk-based on `main`. Same model in every repo.

- Feature branch off `main` → PR → merge. Never push to `main` directly.
- One change per PR. Conventional commit subject (`feat(scope): …`, `fix(scope): …`, `refactor(scope): …`).
- **Bump the version and add the dated CHANGELOG entry in the feature PR itself.** No `[Unreleased]` section; no long-lived release branches. A release is just `main` + a tag + a GitHub release — cut automatically (monorepo) or by the manual steps below (plugins, for now).
- Plugin repos are sibling repos to the monorepo, not submodules. Cross-cutting changes (like sessions-rethink) get coordinated by landing the monorepo PR first, then a matching PR in each affected plugin.

## Semver

- **MAJOR** — breaking change to the MCP tool surface, the slash-command contract, the `source_ref` shape, the projection schema in a way that breaks an in-place upgrade, or any user-visible behaviour that needs a CHANGELOG migration note.
- **MINOR** — new MCP tool, new slash command, new dashboard surface, additive schema bump (drop-and-rebuild memory side is additive — events.jsonl is canonical), new env var with a default.
- **PATCH** — bug fix, doc tweak, internal refactor, test-only change, CI change.

Pre-1.0 (we are at 0.x), MINOR bumps are allowed to carry small breaking changes — but only if the CHANGELOG entry calls them out under `### Removed` or `### Changed`. Once we hit 1.0, breaking changes need a MAJOR.

## Trigger: every merge bumps

There is no "does this PR need a release?" judgement call anymore. **Every merge to `main` bumps the version** (PATCH at minimum) and ships a dated CHANGELOG entry — including internal refactors, test-only changes, CI changes, and doc nits. This removes the failure mode where a change landed on `main` with an `[Unreleased]` note and the version bump was forgotten as a "later" step.

- The bump *size* still follows Semver above (most internal changes are a PATCH).
- A coordinated cross-repo change bumps every affected repo to **the same MINOR**.

When unsure about size, round down to PATCH — a tag and a GitHub release are free, and users who don't upgrade aren't affected.

## Versioning across the family

Plugin versions track the monorepo loosely, not strictly. A monorepo MINOR bump that doesn't change the MCP surface doesn't force every plugin to bump. But a coordinated cross-repo change (like sessions-rethink) should land with **the same MINOR version** across every affected repo, so an operator looking at the dashboard's version badge and the plugin marketplace entries sees the same number everywhere.

---

## Releasing the monorepo (`the-librarian`) — automated

**You don't cut the release; the merge does.** In your feature PR:

1. Bump the root `package.json` (PATCH / MINOR / MAJOR — see Semver).
2. Add a dated `## [X.Y.Z] — YYYY-MM-DD` section at the top of `CHANGELOG.md` and its `[X.Y.Z]:` compare-link at the bottom. (No `[Unreleased]` — the `check:release` guard enforces this.)
3. Open the PR, get CI green, merge.

On the merge, `.github/workflows/release.yml` reads the new version, creates the annotated `vX.Y.Z` tag, and publishes the GitHub release with your CHANGELOG section as the notes. The Docker image rebuilds via CI; the dashboard version badge (which compares the running `package.json` to the latest GitHub release of `JimJafar/the-librarian`) picks it up on its next 1-hour cache refresh — restart the server for an immediate update.

Full details and the enforcement guard: [`docs/release.md`](./release.md).

---

## Releasing a plugin repo (Claude / Codex / Hermes / Pi) — manual, for now

> ⏳ **Migrating.** These repos will get the monorepo's auto-release workflow +
> `check:release` guard. Until then, follow the manual steps — but the policy is
> already the new one: **bump the version file(s) and add a dated CHANGELOG
> section in the feature PR; no `[Unreleased]`.** The only manual part left is
> the tag + GitHub release after merge.

These four follow the same pattern: bump version files → tag → GitHub release. **No npm publish needed.** Marketplace clients and CLI installers pull straight from GitHub.

### Claude plugin

```sh
cd ~/code/the-librarian-claude-plugin
git checkout main && git pull

NEW=0.3.0  # set me

# In the FEATURE PR: bump BOTH version files + add the dated CHANGELOG section.
jq ".version = \"$NEW\"" .claude-plugin/plugin.json > tmp && mv tmp .claude-plugin/plugin.json
jq "(.plugins[] | select(.name == \"the-librarian\")).version = \"$NEW\"" .claude-plugin/marketplace.json > tmp && mv tmp .claude-plugin/marketplace.json
jq ".version = \"$NEW\"" package.json > tmp && mv tmp package.json
$EDITOR CHANGELOG.md  # add `## [$NEW] — <date>` at the top + its compare-link (no [Unreleased])

git checkout -b feat/<change>   # your normal feature branch
git add -A && git commit -m "feat(scope): … (v$NEW)"
git push -u origin HEAD
gh pr create --title "feat(scope): …"

# After CI green + merge:
git checkout main && git pull
git tag -a v$NEW -m "v$NEW" && git push origin v$NEW
gh release create v$NEW --title "v$NEW" --notes-from-tag
```

**Users pick it up by running `/plugin update the-librarian` in Claude Code.** No marketplace action needed — Claude reads `.claude-plugin/marketplace.json` from the default branch on demand.

### Codex plugin

Same shape as Claude. The files to bump are:

- `.codex-plugin/plugin.json` (the `version` field)
- `package.json` (the `version` field)
- `CHANGELOG.md` (dated `## [vNEW]` section, no `[Unreleased]`)

Then tag + GitHub release. Users update by **re-adding** the plugin:
`codex plugin add the-librarian@the-librarian-codex` (there is **no**
`codex plugin update` / `codex plugin path` command — re-add re-pulls the
latest from the marketplace's default branch). Refresh the marketplace clone
first with `codex plugin marketplace upgrade the-librarian-codex` (the
marketplace **name**, not the `owner/repo` path).

### Hermes plugin

Hermes installs the plugin as a directory (no `package.json`/`setup.py`), but its manifest **`plugin.yaml` carries a `version` field — bump it to match the release tag.** (v0.3.0 once shipped with `plugin.yaml` left at `0.2.0` because this doc said "no embedded version"; fixed in v0.3.1 — don't repeat it.) The tag + GitHub release are the changelog anchor and family-wide version correlation.

```sh
cd ~/code/the-librarian-hermes-plugin
git checkout main && git pull
NEW=0.3.2
$EDITOR plugin.yaml CHANGELOG.md   # bump plugin.yaml `version` to $NEW + add dated [$NEW] section
git checkout -b feat/<change>
git add plugin.yaml CHANGELOG.md && git commit -m "feat(scope): … (v$NEW)"
git push -u origin HEAD
gh pr create --title "feat(scope): …"
# merge, then:
git checkout main && git pull
git tag -a v$NEW -m "v$NEW" && git push origin v$NEW
gh release create v$NEW --title "v$NEW" --notes-from-tag
```

Users update via `hermes plugins update the-librarian-hermes-plugin` (re-pulls latest tag).

### Pi extension

Same shape; Pi's version lives in `package.json` (Hermes's in `plugin.yaml`):

```sh
cd ~/code/the-librarian-pi-extension
git checkout main && git pull
NEW=0.3.0
jq ".version = \"$NEW\"" package.json > tmp && mv tmp package.json
$EDITOR CHANGELOG.md   # add dated [$NEW] section (no [Unreleased])
git checkout -b feat/<change>
git add -A && git commit -m "feat(scope): … (v$NEW)"
git push -u origin HEAD
gh pr create --title "feat(scope): …"
# merge → tag → release
git checkout main && git pull
git tag -a v$NEW -m "v$NEW" && git push origin v$NEW
gh release create v$NEW --title "v$NEW" --notes-from-tag
```

Users update via `pi update the-librarian-pi-extension`.

---

## Releasing the OpenCode plugin (npm) — manual, for now

This is the only repo that needs `npm publish`. The version on npm is what `opencode plugin install` resolves against — a GitHub tag alone won't reach users.

```sh
cd ~/code/the-librarian-opencode-plugin
git checkout main && git pull

# 1. In the FEATURE PR: bump + dated CHANGELOG section, like the others
NEW=0.3.0
jq ".version = \"$NEW\"" package.json > tmp && mv tmp package.json
$EDITOR CHANGELOG.md   # add dated [$NEW] section (no [Unreleased])

git checkout -b feat/<change>
git add -A && git commit -m "feat(scope): … (v$NEW)"
git push -u origin HEAD
gh pr create --title "feat(scope): …"

# 2. After PR merge:
git checkout main && git pull
git tag -a v$NEW -m "v$NEW" && git push origin v$NEW
gh release create v$NEW --title "v$NEW" --notes-from-tag

# 3. Publish to npm (separate step from the tag)
npm login                                # only if not already
npm publish --access public              # public scope; check tarball first with `npm pack --dry-run`
npm view the-librarian-opencode-plugin version   # confirm npm shows the new version
```

Notes:
- Always run `npm pack --dry-run` first and read the file list. Anything outside `src/`, `commands/`, `README.md`, `LICENSE`, `package.json` is a smell.
- The repo's `.npmignore` (or `package.json` `files`) is the gate, not `.gitignore`.
- If a publish fails after a tag is already pushed, fix the publish problem and re-run `npm publish` against the same tag. Don't bump the version to "force" a republish — npm doesn't allow republishing the same version anyway.

Users update with `opencode plugin update the-librarian-opencode-plugin` (which calls `npm install` under the hood).

---

## Coordinated cross-repo release

When a change spans the monorepo and one or more plugins (the sessions-rethink rollout is the canonical example), release them in this order:

1. **Monorepo first.** The plugins talk to the server — never ship a plugin that depends on an MCP tool the deployed server doesn't have yet. (The monorepo PR's merge auto-releases it.)
2. **Then each affected plugin**, in any order. The four marketplace-style plugins (Claude / Codex / Hermes / Pi) are independent; the opencode npm publish can lag a few minutes behind them with no consequence.
3. **Use the same MINOR version** across the family for the coordinated bump. PATCH numbers can drift freely between repos.

If the change is **breaking** for the MCP surface (a tool renamed or removed), add a CHANGELOG note in the monorepo's release that names the minimum plugin version compatible with it.

---

## Release-day checklist (copy-paste)

**Monorepo (`the-librarian`) — automated:**

- [ ] In your feature PR: bump root `package.json` (PATCH / MINOR / MAJOR)
- [ ] Add `## [X.Y.Z] — YYYY-MM-DD` at the top of `CHANGELOG.md` + its `[X.Y.Z]:` compare-link (no `[Unreleased]`)
- [ ] `pnpm check:release` passes locally (also enforced by the **release-guard** CI job)
- [ ] CI green → merge. The Release workflow tags + publishes automatically.
- [ ] Verify the GitHub release appeared and the dashboard version badge shows "up to date" (restart the server, or wait for the 1-hour cache)

**A plugin repo — manual until migrated:**

- [ ] In your feature PR: bump the version file(s) — `package.json`, plus plugin manifest JSONs for Claude/Codex, or `plugin.yaml` for Hermes
- [ ] Add `## [X.Y.Z] — YYYY-MM-DD` to `CHANGELOG.md` (no `[Unreleased]`)
- [ ] CI green → merge
- [ ] `git tag -a vX.Y.Z` on `main` and push the tag
- [ ] `gh release create vX.Y.Z --notes-from-tag`
- [ ] **OpenCode only:** `npm publish --access public`; confirm `npm view` reports the new version

For a coordinated cross-repo release: do the monorepo first, then loop through the affected plugins in any order. Same MINOR version across all of them.

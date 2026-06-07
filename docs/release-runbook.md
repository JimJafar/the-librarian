# The Librarian — release runbook

How we cut releases across the six repos. Pragmatic. Trunk-based. No release branches.

## Repos at a glance

| Repo | Artifact | Version source | Install path |
|---|---|---|---|
| `the-librarian` | Docker image, GitHub release | root `package.json` | `docker compose ... up -d` |
| `the-librarian-claude-plugin` | GitHub tag/release | `.claude-plugin/plugin.json` **and** `.claude-plugin/marketplace.json` | `/plugin marketplace add` |
| `the-librarian-codex-plugin` | GitHub tag/release | `.codex-plugin/plugin.json` **and** `package.json` | `codex plugin marketplace add` |
| `the-librarian-hermes-plugin` | GitHub tag/release | **`plugin.yaml` `version`** | `hermes plugins install <git>` |
| `the-librarian-opencode-plugin` | **npm** package + GitHub release | `package.json` | `opencode plugin install` (npm-backed) |
| `the-librarian-pi-extension` | GitHub tag/release | `package.json` | `pi install git:...` |

Only **opencode** needs `npm publish`. The other four plugins ship by git tag — the marketplace clients (Claude / Codex) and CLI installers (Hermes, Pi) pull straight from GitHub.

## Branching strategy

Trunk-based on `main`. Same model in every repo.

- Feature branch off `main` → PR → merge. Never push to `main` directly.
- One change per PR. Conventional commit subject (`feat(scope): …`, `fix(scope): …`, `refactor(scope): …`).
- No long-lived release branches. A release is just `main` + a tag + a GitHub release.
- Plugin repos are sibling repos to the monorepo, not submodules. Cross-cutting changes (like sessions-rethink) get coordinated by landing the monorepo PR first, then a matching PR in each affected plugin.

## Semver

- **MAJOR** — breaking change to the MCP tool surface, the slash-command contract, the `source_ref` shape, the projection schema in a way that breaks an in-place upgrade, or any user-visible behaviour that needs a CHANGELOG migration note.
- **MINOR** — new MCP tool, new slash command, new dashboard surface, additive schema bump (drop-and-rebuild memory side is additive — events.jsonl is canonical), new env var with a default.
- **PATCH** — bug fix, doc tweak, internal refactor, test-only change.

Pre-1.0 (we are at 0.x), MINOR bumps are allowed to carry small breaking changes — but only if the CHANGELOG entry calls them out under `### Removed` or `### Changed`. Once we hit 1.0, breaking changes need a MAJOR.

## Trigger: when does a PR need a release?

A merged PR needs a release when **any** of these is true:

- The change is user-visible (new feature, bug fix that affects behaviour, doc change that affects install/config).
- The change touches the MCP tool surface, the slash-command contract, or the projection schema.
- The change ships across multiple repos in lockstep (then everything bumps together).

Internal refactors, test changes, CI changes, and doc nits that don't touch install/config can land on `main` without a release.

When in doubt, cut the release. A `git tag` and a GitHub release are free; users who don't upgrade aren't affected.

## Versioning across the family

Plugin versions track the monorepo loosely, not strictly. A monorepo MINOR bump that doesn't change the MCP surface doesn't force every plugin to bump. But a coordinated cross-repo change (like sessions-rethink) should land with **the same MINOR version** across every affected repo, so an operator looking at the dashboard's version badge and the plugin marketplace entries sees the same number everywhere.

---

## Releasing the monorepo (`the-librarian`)

The dashboard's version badge reads the running `package.json` and compares against the latest GitHub release of `JimJafar/the-librarian`. So the badge stays "up to date" only if `package.json` matches the latest GitHub release tag.

```sh
cd ~/code/the-librarian
git checkout main && git pull

# 1. Bump root package.json
npm version <patch|minor|major> --no-git-tag-version

# 2. Move CHANGELOG [Unreleased] entries under [vX.Y.Z] - YYYY-MM-DD, leave [Unreleased] empty
$EDITOR CHANGELOG.md

# 3. Commit on a release branch, PR it
NEW=$(jq -r .version package.json)
git checkout -b release/v$NEW
git add package.json CHANGELOG.md
git commit -m "chore(release): v$NEW"
git push -u origin release/v$NEW
gh pr create --title "chore(release): v$NEW" --body "Release notes in CHANGELOG.md"

# 4. After CI passes and merge:
git checkout main && git pull
git tag -a v$NEW -m "v$NEW"
git push origin v$NEW

# 5. Create the GitHub release (copy the CHANGELOG section as notes)
gh release create v$NEW --title "v$NEW" --notes-from-tag
```

The Docker image rebuild is automatic via CI on tag push (or rebuild via `docker compose up -d --build` on each deployment). The version badge picks up the new release on its next 1-hour cache refresh; restart the server for an immediate update.

---

## Releasing a plugin repo (Claude / Codex / Hermes / Pi)

These four follow the same pattern: bump version files → tag → GitHub release. **No npm publish needed.** Marketplace clients and CLI installers pull straight from GitHub.

### Claude plugin

```sh
cd ~/code/the-librarian-claude-plugin
git checkout main && git pull

NEW=0.3.0  # set me

# Bump BOTH files
jq ".version = \"$NEW\"" .claude-plugin/plugin.json > tmp && mv tmp .claude-plugin/plugin.json
jq "(.plugins[] | select(.name == \"the-librarian\")).version = \"$NEW\"" .claude-plugin/marketplace.json > tmp && mv tmp .claude-plugin/marketplace.json
jq ".version = \"$NEW\"" package.json > tmp && mv tmp package.json

$EDITOR CHANGELOG.md  # move Unreleased → [vNEW]

git checkout -b release/v$NEW
git add -A && git commit -m "chore(release): v$NEW"
git push -u origin release/v$NEW
gh pr create --title "chore(release): v$NEW" --body-file <(awk "/## \[$NEW\]/,/## \[/" CHANGELOG.md | head -n -1)

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
- `CHANGELOG.md`

Then tag + GitHub release. Users update via `codex plugin update the-librarian`.

### Hermes plugin

Hermes installs the plugin as a directory (no `package.json`/`setup.py`), but its manifest **`plugin.yaml` carries a `version` field — bump it to match the release tag.** (v0.3.0 once shipped with `plugin.yaml` left at `0.2.0` because this doc said "no embedded version"; fixed in v0.3.1 — don't repeat it.) The tag + GitHub release are the changelog anchor and family-wide version correlation.

```sh
cd ~/code/the-librarian-hermes-plugin
git checkout main && git pull
NEW=0.3.2
$EDITOR plugin.yaml CHANGELOG.md   # bump plugin.yaml `version` to $NEW + move CHANGELOG
git checkout -b release/v$NEW
git add plugin.yaml CHANGELOG.md && git commit -m "chore(release): v$NEW"
git push -u origin release/v$NEW
gh pr create --title "chore(release): v$NEW"
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
$EDITOR CHANGELOG.md
git checkout -b release/v$NEW
git add -A && git commit -m "chore(release): v$NEW"
git push -u origin release/v$NEW
gh pr create --title "chore(release): v$NEW"
# merge → tag → release
git checkout main && git pull
git tag -a v$NEW -m "v$NEW" && git push origin v$NEW
gh release create v$NEW --title "v$NEW" --notes-from-tag
```

Users update via `pi update the-librarian-pi-extension`.

---

## Releasing the OpenCode plugin (npm)

This is the only repo that needs `npm publish`. The version on npm is what `opencode plugin install` resolves against — a GitHub tag alone won't reach users.

```sh
cd ~/code/the-librarian-opencode-plugin
git checkout main && git pull

# 1. Bump + CHANGELOG, like the others
NEW=0.3.0
jq ".version = \"$NEW\"" package.json > tmp && mv tmp package.json
$EDITOR CHANGELOG.md

git checkout -b release/v$NEW
git add -A && git commit -m "chore(release): v$NEW"
git push -u origin release/v$NEW
gh pr create --title "chore(release): v$NEW"

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

1. **Monorepo first.** The plugins talk to the server — never ship a plugin that depends on an MCP tool the deployed server doesn't have yet.
2. **Then each affected plugin**, in any order. The four marketplace-style plugins (Claude / Codex / Hermes / Pi) are independent; the opencode npm publish can lag a few minutes behind them with no consequence.
3. **Use the same MINOR version** across the family for the coordinated bump. PATCH numbers can drift freely between repos.

If the change is **breaking** for the MCP surface (a tool renamed or removed), add a CHANGELOG note in the monorepo's release that names the minimum plugin version compatible with it.

---

## Release-day checklist (copy-paste)

For a single repo release:

- [ ] `git checkout main && git pull` (clean working tree)
- [ ] Decide version bump (PATCH / MINOR / MAJOR — see Semver above)
- [ ] Bump version file(s) — `package.json`, plus plugin manifest JSONs for Claude/Codex
- [ ] Move `[Unreleased]` CHANGELOG entries under `[vX.Y.Z] - YYYY-MM-DD`
- [ ] Branch + commit + PR with title `chore(release): vX.Y.Z`
- [ ] Wait for CI green; merge
- [ ] Tag `vX.Y.Z` on `main` and push the tag
- [ ] `gh release create vX.Y.Z --notes-from-tag`
- [ ] **OpenCode only:** `npm publish --access public`; confirm `npm view` reports the new version
- [ ] **Monorepo only:** redeploy (or wait for the dashboard cache refresh) and verify the version badge shows "up to date"

For a coordinated cross-repo release: do the monorepo first, then loop through the affected plugins in any order. Same MINOR version across all of them.

# Releasing `the-librarian`

This is the per-repo release file. The full cross-family runbook (branching
strategy, semver rules, version-coordination across the family, the OpenCode
npm flow) lives in [`docs/release-runbook.md`](./release-runbook.md). Read
that first if you're new to releases here.

## When to cut a release

Any merged PR that is **user-visible** (new MCP tool, dashboard surface
change, schema-affecting refactor, bug fix that changes observable
behaviour, install / config / env-var change, doc update that affects
operators) earns a release. Internal-only refactors, test-only changes,
and CI-only changes don't. When in doubt, cut it — a tag and a GitHub
release are free.

## Semver, the short version

- **MAJOR** — breaking change to the MCP surface, the slash-command
  contract, the `source_ref` shape, or an in-place projection-schema
  upgrade that breaks v(N) clients against v(N+1) data.
- **MINOR** — new MCP tool, new slash command, new dashboard surface,
  additive schema bump, new env var with a default.
- **PATCH** — bug fix, doc tweak, internal refactor, test-only change.

Pre-1.0, MINOR is allowed to carry small breakings if the CHANGELOG
calls them out under `### Removed` or `### Changed`.

## Steps

```sh
cd ~/code/the-librarian
git checkout main && git pull

# 1. Bump the root package.json
NEW=<X.Y.Z>
npm version $NEW --no-git-tag-version

# 2. Move CHANGELOG [Unreleased] entries under [vX.Y.Z] - YYYY-MM-DD;
#    leave [Unreleased] empty.
$EDITOR CHANGELOG.md

# 3. Branch, commit, PR
git checkout -b release/v$NEW
git add package.json CHANGELOG.md
git commit -m "chore(release): v$NEW"
git push -u origin release/v$NEW
gh pr create --title "chore(release): v$NEW"

# 4. After CI green + merge
git checkout main && git pull
git tag -a v$NEW -m "v$NEW"
git push origin v$NEW
gh release create v$NEW --title "v$NEW" --notes-from-tag
```

The dashboard version badge picks up the new release on its next
1-hour cache refresh; restart the server for an immediate update.

## Coordinating with the plugin repos

A change that ships across this repo and one or more plugin repos
(the sessions-rethink rollout is the canonical example) releases
**monorepo first**, then each affected plugin at the same MINOR
version. The full cross-family rules are in
[`docs/release-runbook.md`](./release-runbook.md#coordinated-cross-repo-release).

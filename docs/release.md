# Releasing `the-librarian`

**Merging to `main` IS the release.** There is no separate release PR, no
`release/vX` branch, and no hand-run `git tag` / `gh release` for this repo.
Every PR bumps the version and writes its CHANGELOG entry; the merge cuts the
tag + GitHub release automatically. This file is the per-repo bump-size rule;
the cross-family runbook (which repos, version files, coordinated bumps) lives
in [`docs/release-runbook.md`](./release-runbook.md).

## The model

1. **Every PR bumps the root `package.json`** — PATCH at minimum. There are no
   "no-release" PRs on `main`: even an internal refactor or doc fix takes a PATCH.
2. **The CHANGELOG has no `[Unreleased]` section.** File your notes directly
   under a new dated heading at the top:

   ```md
   ## [X.Y.Z] — YYYY-MM-DD

   ### Added
   - ...
   ```

   and add the compare-link at the bottom:

   ```md
   [X.Y.Z]: https://github.com/JimJafar/the-librarian/compare/v<prev>...vX.Y.Z
   ```

3. **Merge to `main`.** `.github/workflows/release.yml` reads the version, and
   if `vX.Y.Z` isn't tagged yet, creates the annotated tag + the GitHub release
   (notes taken from your CHANGELOG section). It is idempotent: a merge that
   didn't bump the version is a clean no-op.

That's the whole contributor job — the `package.json` bump and the CHANGELOG
entry. The workflow does the rest.

## Enforcement

`scripts/check-release.mjs` (run locally as `pnpm check:release`, and in CI as
the **release-guard** job) fails your PR if:

- the CHANGELOG still has an `## [Unreleased]` heading or `[Unreleased]:` link,
- the top CHANGELOG heading isn't `## [<package.json version>] — <ISO date>`,
- the date isn't a real `YYYY-MM-DD`, or the `[X.Y.Z]:` compare-link is missing,
- the version wasn't raised above `main` (the PR forgot to bump).

So you can't merge a change without a version + changelog entry — which is how
`[Unreleased]` sections and forgotten bumps used to reach `main`.

## Semver, the short version

- **MAJOR** — breaking change to the MCP surface, the slash-command contract,
  the `source_ref` shape, or an in-place projection-schema upgrade that breaks
  v(N) clients against v(N+1) data.
- **MINOR** — new MCP tool, new slash command, new dashboard surface, additive
  schema bump, new env var with a default.
- **PATCH** — bug fix, doc tweak, internal refactor, test-only or CI change.

Pre-1.0, MINOR is allowed to carry small breakings if the CHANGELOG calls them
out under `### Removed` or `### Changed`.

## Picking a version when others are in flight

The version lives in two tracked places (`package.json` + the CHANGELOG
heading), so two PRs that both bump to the same number **conflict on merge** —
by design. The second one rebases onto `main` and re-picks the next number.
Don't fight the conflict; let it make you choose a fresh version.

## After the release

The Docker image rebuilds via CI, and deployment is automatic on merge. The
dashboard version badge reads the running `package.json` and compares it to the
latest GitHub release of `JimJafar/the-librarian`, refreshing on its 1-hour
cache (restart the server for an immediate update).

## Coordinating with the plugin repos

A change that ships across this repo and one or more plugin repos releases
**monorepo first**, then each affected plugin at the same MINOR version. The
plugin repos are migrating to this same auto-release model; until a given repo
has the Release workflow, follow its manual steps in
[`docs/release-runbook.md`](./release-runbook.md#coordinated-cross-repo-release)
— but the rule is identical there: bump + dated CHANGELOG entry in the same PR,
no `[Unreleased]`.

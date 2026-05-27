# Spec: Claude Plugin Lifecycle-Source Restoration

**Author:** Claude, with Jim
**Date:** 2026-05-27
**Status:** Draft v1 — vendor approach chosen; awaiting implementation

---

## 1. Purpose

The `the-librarian-claude-plugin` repo ships two committed hook bins (`bin/librarian-claude-hook.js` and `bin/librarian-mcp-call.js`) that were generated from `@librarian/lifecycle` source living in this repo at `integrations/shared/librarian-lifecycle/`. That source tree was **deleted entirely in PR #153** (see CHANGELOG.md §Removed). The committed bundles still run at runtime, but `scripts/build-bundle.mjs` can no longer regenerate them — it points at a path that does not exist.

The drift guard in `scripts/validate.mjs` (which hashes the bundles against `bin/PROVENANCE.json`) means we *also* cannot edit the bundles by hand — any change will fail CI. We have working artefacts with no path back to source.

The recent conv-state-injection PR ([the-librarian-claude-plugin#9](https://github.com/JimJafar/the-librarian-claude-plugin/pull/9)) sidestepped the problem by adding a *separate* self-contained `bin/librarian-conv-state-inject.mjs` that does not depend on the lifecycle bundle. That works for one bounded addition, but the lifecycle bundle itself is now frozen until we restore a buildable source tree.

This spec defines that restoration.

---

## 2. Non-goals

- **Not redesigning the Claude plugin.** The intent is to recover the buildable state we had before PR #153, not to take the opportunity to refactor.
- **Not changing the runtime behaviour of the lifecycle hook.** The currently committed bundle is the bug-for-bug-compatible baseline. The first-merge build of the restored source must produce a bundle that runs the existing tests / smoke suite identically (modulo whitespace / minification).
- **Not unifying the five plugin lifecycle implementations.** Codex, opencode, pi, and hermes each own their own source already. Claude is the outlier we're bringing in line — peer parity, not unification.
- **Not consolidating into a new shared package.** The deletion in PR #153 was deliberate (per CHANGELOG: "the `@librarian/lifecycle` workspace package was orphaned (zero consumers outside its own package.json) and removed"). Re-creating it as a shared dependency would re-introduce the cross-repo coupling the deletion eliminated.

---

## 3. Background

Pre-PR-#153 layout:

```
the-librarian/
  integrations/
    shared/
      librarian-lifecycle/      ← TypeScript source
        src/                    (lifecycle, harness adapters, mcp-call helper)
        dist/                   (compiled output)
        package.json            ← @librarian/lifecycle
    claude-code/                ← in-tree thin plugin, since deleted
the-librarian-claude-plugin/    (sibling repo)
  scripts/build-bundle.mjs       ← esbuild that reads ../the-librarian/integrations/shared/librarian-lifecycle/dist/
  bin/
    librarian-claude-hook.js    ← committed bundle (output of build)
    librarian-mcp-call.js       ← committed bundle (output of build)
    PROVENANCE.json             ← sha256 of the two bundles, recorded at build time
```

Post-PR-#153 layout:

```
the-librarian/                  ← integrations/ deleted entirely
the-librarian-claude-plugin/
  scripts/build-bundle.mjs      ← still references the deleted path; broken
  bin/
    librarian-claude-hook.js    ← committed; still runs; cannot be regenerated
    librarian-mcp-call.js       ← committed; still runs; cannot be regenerated
    PROVENANCE.json             ← still hash-validated by validate.mjs
```

The source of truth for the bundle bytes lives in git history (any commit pre-PR-#153 in the main repo). It does not live in either repo's working tree as of today.

The four other plugin repos (`codex`, `opencode`, `pi-extension`, `hermes`) each ship their own `src/` tree post-graduation. The Claude plugin was the lone holdout because it was the most-coupled to the shared package.

---

## 4. The contract

### 4.1 Where the source lives

`the-librarian-claude-plugin/src/` — a new directory in the plugin repo, structured to mirror the other plugins:

```
the-librarian-claude-plugin/
  src/
    bin/
      claude-code-hook.mts        ← entry point bundled to bin/librarian-claude-hook.js
      mcp-call.mts                ← entry point bundled to bin/librarian-mcp-call.js
    lifecycle.mts                 ← createLibrarianLifecycle (the engine)
    mcp-client.mts                ← the HTTP MCP client (DEFAULT_TIMEOUT_MS, callTool, etc.)
    remote-cli.mts                ← createRemoteLibrarianCli (the subprocess wrapper)
    harness/
      claude-code.mts             ← createClaudeCodeLifecycle, claudeLocationFromEvent
    privacy.mts                   ← DEFAULT_PRIVATE_MARKERS, DEFAULT_PUBLIC_MARKERS, detectPrivacySignal
    state.mts                     ← loadState / updateState / composeState
    config.mts                    ← config schema + defaults
    types.mts                     ← shared types
  bin/                            ← unchanged; committed bundle outputs
  scripts/
    build-bundle.mjs              ← rewritten to read from ./src/, not ../the-librarian/...
```

`.mts` (TypeScript with explicit ESM extension) is chosen to match the family convention used by the opencode plugin's `src/`. Codex and Pi use `.mjs` plain JS; we could match them instead. Recommendation: TS for type safety since the lifecycle is the most complex of the five plugins. **Open question — §9.**

### 4.2 Source provenance

The bytes for `src/` come from **`@librarian/lifecycle/src/`** as of its last commit in `the-librarian` before PR #153. Specifically, the commit immediately preceding the `integrations/` deletion. The CHANGELOG entry for PR #153 names the rev range; the restoration commit message must cite the exact SHA the source was extracted from.

This is bug-for-bug compatible by construction — we are bringing back the same source that produced the currently-committed bundles. Any subsequent improvements ride on top, but the first commit of `src/` must produce a bundle whose runtime behaviour is unchanged.

### 4.3 Build pipeline

`scripts/build-bundle.mjs` is rewritten to:

- Read entry points from `./src/bin/claude-code-hook.mts` and `./src/bin/mcp-call.mts`.
- Bundle each with `esbuild` (already a devDependency) into `bin/librarian-claude-hook.js` and `bin/librarian-mcp-call.js`, ESM format, `node18` target — same flags as the pre-PR-#153 build.
- Stamp `bin/PROVENANCE.json` with: `{ source: "in-tree", repoSha: <plugin-repo HEAD>, bins: { … sha256s … } }`. (The previous PROVENANCE had `monorepoSha` and `lifecycleVersion` fields tied to the cross-repo dependency — those become moot and are dropped.)
- Refuse to build if any committed `src/` file has uncommitted changes (so the PROVENANCE always points at a real, push-able commit).

The pre-commit / CI hash check in `validate.mjs` continues to work unchanged — it doesn't care where the source came from, only that the bundle on disk matches the recorded hash.

### 4.4 Co-existence with the conv-state-inject bin

The recent `bin/librarian-conv-state-inject.mjs` is a separate, self-contained bin that does *not* live under `src/`. Two options:

- **Leave it as a self-contained `.mjs`** — simplest, keeps the conv-state surface decoupled from the lifecycle. Hash-validation gets extended to cover this bin too.
- **Move it under `src/` and bundle it like the others** — uniformity. Slightly more friction (the conv-state helper has to live alongside the lifecycle modules) but a single build pipeline.

Recommendation: **move under `src/`** at the same time as the restoration, so there's exactly one build path. The restoration is the natural moment to absorb the inject bin into the same source tree.

### 4.5 Privacy-detector marker list parity

The privacy marker list (`DEFAULT_PRIVATE_MARKERS` / `DEFAULT_PUBLIC_MARKERS`) is one of the "five peer implementations, no canonical source" things from AGENTS.md §2. The restoration imports those markers from the previously-bundled source. **Any change to those lists is still cross-repo coordinated work** — the restoration must not change them.

The other four plugins (codex, opencode, pi, hermes) have their own copies of the marker list. The restoration does not introduce a dependency between them.

---

## 5. Tech stack

- **Plugin repo:** the-librarian-claude-plugin (unchanged scope).
- **Build tool:** esbuild (already devDependency; no change).
- **TypeScript runtime:** node-native `.mts` modules, no transpilation in the bundle pipeline (esbuild handles it). If we go with `.mjs` plain JS, no TypeScript dep at all.
- **No new runtime dependencies.** The bundle is dependency-light by design.
- **No changes to the main `the-librarian` repo.** All work lives in the plugin repo.

---

## 6. Decisions

- **D1.** Vendor approach: extract `@librarian/lifecycle/src/` from main-repo git history pre-PR-#153 and commit it into the plugin's new `src/`. Rationale: bug-for-bug compatibility is free; no behavioural drift to debug.
- **D2.** `.mts` TypeScript modules. Matches the opencode plugin (the most recent peer) and gives the most-complex of the five plugins compile-time safety. **Re-evaluate if the `.mts` runtime story is bumpy on user machines.**
- **D3.** Single `src/` for both lifecycle and the conv-state inject. The inject bin moves under `src/` as part of the restoration so there's one build pipeline.
- **D4.** PROVENANCE drops `monorepoSha` and `lifecycleVersion`; gains a plain `repoSha` of the plugin repo. Old PROVENANCE bytes are not preserved.
- **D5.** Privacy markers are imported verbatim from the pre-deletion source. The five-peer no-canonical-source contract is preserved; cross-repo coordination remains the only path to changing them.

---

## 7. Migration / rollout

One PR in the plugin repo. Stages:

1. **Recover the source.** Use `git -C ../the-librarian checkout <pre-PR-#153-sha> -- integrations/shared/librarian-lifecycle/src/` into a temp dir, then `git mv` the relevant files into `the-librarian-claude-plugin/src/`. Commit message records the SHA.
2. **Rewrite `scripts/build-bundle.mjs`** to read from `./src/`. Run it; confirm the output `bin/librarian-claude-hook.js` is functionally equivalent (smoke suite passes byte-by-byte may differ but behaviour is identical).
3. **Move `bin/librarian-conv-state-inject.mjs` under `src/`** and rewire its build entry. Update `hooks/hooks.json` if the bin path changes; otherwise it can stay at `bin/librarian-conv-state-inject.js` (compiled).
4. **Update `scripts/validate.mjs`** to hash-check all three bins (lifecycle hook, mcp-call, conv-state inject) against PROVENANCE.
5. **Regenerate PROVENANCE.json** with the new schema (no more `monorepoSha`/`lifecycleVersion`).
6. **CHANGELOG entry** under `## [Unreleased]` describing the restoration, the new build pipeline, and the dropped PROVENANCE fields.

No data / state migration on user machines. The user's installed plugin keeps running the committed bundle; the next plugin update ships the rebuilt-from-source bundles.

---

## 8. Success criteria

- [ ] `scripts/build-bundle.mjs` runs end-to-end without referencing any path outside `the-librarian-claude-plugin/`.
- [ ] `scripts/validate.mjs` passes against the rebuilt bins, with PROVENANCE entries for all three.
- [ ] `scripts/smoke.mjs` (all three test paths — mcp-call, dispatch, inject-conv-state) passes against the rebuilt bins.
- [ ] The user-visible runtime behaviour is unchanged: identical privacy gate, identical lifecycle dispatch, identical conv-state injection.
- [ ] The plugin can ship a new release independently of the main repo, with no cross-repo path resolution required to build.
- [ ] The CHANGELOG entry explicitly records that the marker list is unchanged from pre-restoration and remains coordinated across the five peer plugins.

---

## 9. Open questions

- **`.mts` vs `.mjs`.** TypeScript gives compile-time safety on the most-complex of the five plugins; plain JS matches codex / pi exactly and avoids the `.mts` resolver edge cases that occasionally surface on older Node versions. Recommendation TS, but worth a 5-minute look at any user-machine issues from the opencode plugin's `.mts` adoption before locking in.
- **Should we also commit a `dist/` ahead of the bundle?** Esbuild bundles directly from source; an intermediate `dist/` is not strictly needed, but having it gives users with weird esbuild versions a working tree to point at. Probably not — keep the build path single-shot.
- **What about the deleted `integrations/claude-code/` thin plugin?** That was the user-facing install surface that PR #153 also removed. The standalone plugin already replaces it; nothing to restore. (Noted here only so the question is closed in the spec.)
- **Marker-list five-peer drift.** Out of scope for restoration but worth flagging: with five peer copies of the privacy marker list and no canonical source, any change is a five-repo coordinated push. We have no automated detector for drift. A small "compare marker lists across the five repos" CI job in this repo (or any one of them) would catch silent drift. Not blocking; a follow-up.

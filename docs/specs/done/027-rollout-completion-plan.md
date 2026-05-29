# Plan: Rollout Completion — Four-Spec Autonomous Build

Companion implementation plan covering the four follow-up specs from the memory-domain-isolation rollout:

- [`023-classifier-implementation-spec.md`](./023-classifier-implementation-spec.md)
- [`024-claude-plugin-lifecycle-restoration-spec.md`](./024-claude-plugin-lifecycle-restoration-spec.md)
- [`025-opencode-conv-state-injection-spec.md`](./025-opencode-conv-state-injection-spec.md)
- [`026-pi-extension-conv-state-injection-spec.md`](./026-pi-extension-conv-state-injection-spec.md)

The specs define **what** and **why**; this plan defines **how**, in **what order**, with **acceptance criteria** and **verification steps** per task. Designed for `/autonomous-build` execution.

---

## Status

Drafted 2026-05-27. Not started.

The four specs are all merged to `main` at SHA `5485a7b` (PR #172). This plan sequences their implementation into a single autonomous build, broken into four sections for the four specs.

---

## Overview

The memory-domain-isolation rollout currently sits at PRs 1–5 merged. The four follow-up specs close out:

- **PR 6 of the original rollout plan** (collapsed PR 6 + PR 7) — classifier implementation. Touches the main repo.
- **Three sibling-repo deliverables** — Claude plugin lifecycle restoration, opencode conv-state injection, Pi extension conv-state injection. Each touches one sibling repo.

When this plan completes, every spec produced during the rollout has a corresponding implementation merged to its repo's main branch.

---

## Architecture decisions (this plan)

- **One plan, four sections, ordered for autonomous execution.** Decided by Jim, 2026-05-27. The four specs are mutually independent (no hard sequencing dependencies between them), but a single plan lets `/autonomous-build` work through them as one continuous session.
- **Risk-graded ordering.** Sections progress from lowest implementation risk (Claude restoration — six well-enumerated migration steps) to highest (classifier — touches real user memories via backfill). The ordering is deliberate: build momentum and confidence on the small specs before the big one.
- **One section completes before the next starts.** Each section ends with a "Section complete" checkpoint and merges its PR(s) before the next section's first task begins. This bounds the failure radius — if Section 2 goes wrong, Sections 3–4 are unaffected.
- **Eyeball-test gates honoured.** Sections 2 (Pi) and 3 (opencode) require a real-session eyeball test before their PRs merge, per the specs' §7. The autonomous build pauses for these gates and asks Jim to confirm.
- **Backfill is in-band.** Section 4 (classifier) includes the migration backfill of existing memories as Task 4.8, run within the implementation session. Real-data quality becomes visible immediately rather than gated behind a separate operation.

---

## Section dependency graph

```
                ┌────────────────────────────────────┐
                │ Section 1 — Claude plugin          │
                │ lifecycle restoration              │
                │ (the-librarian-claude-plugin repo) │
                └────────────────┬───────────────────┘
                                 │
                                 ▼
                ┌────────────────────────────────────┐
                │ Section 2 — Pi extension           │
                │ conv-state injection               │
                │ (the-librarian-pi-extension repo)  │
                └────────────────┬───────────────────┘
                                 │
                                 ▼
                ┌────────────────────────────────────┐
                │ Section 3 — opencode               │
                │ conv-state injection               │
                │ (the-librarian-opencode-plugin)    │
                └────────────────┬───────────────────┘
                                 │
                                 ▼
                ┌────────────────────────────────────┐
                │ Section 4 — Classifier             │
                │ implementation (PR 6 collapsed)    │
                │ (the-librarian main repo)          │
                └────────────────────────────────────┘
```

Sequential. No parallelisation needed (or desirable — each section produces its own PR with its own CI cycle).

---

## Section 1 — Claude plugin lifecycle restoration

**Spec:** [`024-claude-plugin-lifecycle-restoration-spec.md`](./024-claude-plugin-lifecycle-restoration-spec.md).
**Working tree:** `~/code/the-librarian-claude-plugin`.
**Output:** one PR in `the-librarian-claude-plugin` merged to main.

Sequenced first because: smallest scope; fails fast (Task 1.1 either finds the pre-PR-#153 source in main-repo git history or it doesn't); resolves the broken-build state that blocks future Claude plugin work.

### Task 1.1 — Locate the pre-PR-#153 SHA

**Description:** In the main repo's git history, identify the commit immediately before PR #153 deleted `integrations/shared/librarian-lifecycle/src/`. Verify the source tree at that SHA is complete and matches the bundled bytes in the plugin's current `bin/librarian-claude-hook.js` (at least functionally — esbuild output won't be byte-identical, but module exports + privacy markers + lifecycle entry points must match).

**Acceptance criteria:**
- [ ] A specific main-repo SHA is identified and recorded.
- [ ] `git -C ../the-librarian show <sha>:integrations/shared/librarian-lifecycle/src/` lists a complete `src/` tree (lifecycle, harness/claude-code, privacy, state, mcp-client, remote-cli, bin/claude-code-hook.ts, bin/mcp-call.ts).
- [ ] The privacy marker arrays in the extracted source match the markers visible in the current committed bundle (`grep "DEFAULT_PRIVATE_MARKERS" bin/librarian-claude-hook.js`).

**Verification:** the SHA is captured for use in Task 1.2. If the source tree is missing or corrupted (history rewrite, partial deletion), HALT — the spec's assumption is invalid and we escalate.

**Dependencies:** none.

**Files likely touched:** none in the plugin repo. This is investigation only — output is the SHA recorded in the commit message of Task 1.2.

**Scope:** XS.

### Task 1.2 — Extract source into the plugin's `src/`

**Description:** Create `the-librarian-claude-plugin/src/` and populate it from the main-repo source at the SHA from Task 1.1. Preserve file layout (lifecycle.mts at root, harness/ subdir, bin/ subdir for entry points). Commit with the SHA cited explicitly in the commit message.

**Acceptance criteria:**
- [ ] `the-librarian-claude-plugin/src/` exists with the extracted source.
- [ ] File extensions are `.mts` (TypeScript modules) — matches opencode plugin convention.
- [ ] Commit message records the source SHA verbatim.

**Verification:** `tsc --noEmit -p <new tsconfig>` against the extracted source succeeds. No code execution; just compile-clean.

**Dependencies:** Task 1.1.

**Files likely touched:** new files under `src/` (the/librarian-claude-plugin); new or modified `tsconfig.json`.

**Scope:** S.

### Task 1.3 — Rewrite `scripts/build-bundle.mjs` for in-repo source

**Description:** Replace the cross-repo path resolution in `scripts/build-bundle.mjs` with in-repo paths (`./src/bin/claude-code-hook.mts` → `bin/librarian-claude-hook.js`; `./src/bin/mcp-call.mts` → `bin/librarian-mcp-call.js`). Drop the `LIBRARIAN_MONOREPO` env-var override. Stamp PROVENANCE with the new schema (drop `monorepoSha` and `lifecycleVersion`; add `repoSha`).

**Acceptance criteria:**
- [ ] `node scripts/build-bundle.mjs` runs end-to-end with no reference to any path outside the plugin repo.
- [ ] `bin/librarian-claude-hook.js` and `bin/librarian-mcp-call.js` are produced.
- [ ] `bin/PROVENANCE.json` has the new schema: `{ source: "in-tree", repoSha, bins: { ...sha256s } }`.

**Verification:** `node scripts/build-bundle.mjs && node scripts/validate.mjs` — both succeed.

**Dependencies:** Task 1.2.

**Files likely touched:** `scripts/build-bundle.mjs`, `bin/librarian-claude-hook.js`, `bin/librarian-mcp-call.js`, `bin/PROVENANCE.json`.

**Scope:** S.

### Task 1.4 — Verify rebuilt bundle is functionally identical

**Description:** Run the plugin's existing smoke suite (`scripts/smoke.mjs`) against the rebuilt bundles. All three smoke paths (mcp-call, dispatch, inject-conv-state) must pass — same byte-for-byte output expected as the pre-restoration bundles for equivalent inputs.

**Acceptance criteria:**
- [ ] All three smoke suites pass.
- [ ] No behavioural regression versus the pre-restoration committed bundles.

**Verification:** `node scripts/smoke.mjs` — exit 0 with all three paths reporting ✓.

**Dependencies:** Task 1.3.

**Files likely touched:** none new — verification only.

**Scope:** XS.

### Task 1.5 — Absorb `librarian-conv-state-inject.mjs` into `src/`

**Description:** Move the self-contained `bin/librarian-conv-state-inject.mjs` (added in the earlier conv-state injection PR) under `src/` and rewire the build to bundle it as the third committed bin. Update `hooks/hooks.json` only if the bin path changes; otherwise the existing entry stays. Update `scripts/validate.mjs` to hash-check the third bin against PROVENANCE.

**Acceptance criteria:**
- [ ] Inject source lives under `src/` (e.g. `src/bin/conv-state-inject.mts`).
- [ ] Build pipeline produces all three bins from one `build-bundle.mjs` invocation.
- [ ] PROVENANCE records hashes for all three bins.
- [ ] `scripts/validate.mjs` enforces all three.

**Verification:** rebuild + smoke + validate — all green.

**Dependencies:** Task 1.4.

**Files likely touched:** `src/bin/conv-state-inject.mts` (new), `scripts/build-bundle.mjs`, `scripts/validate.mjs`, `bin/PROVENANCE.json`.

**Scope:** S.

### Task 1.6 — CHANGELOG + PR

**Description:** Update `CHANGELOG.md` under `## [Unreleased]` describing the restoration. Push the branch; open a PR; watch CI; merge via rebase.

**Acceptance criteria:**
- [ ] CHANGELOG entry under `## [Unreleased]` explains the restoration, the build-script rewrite, the absorbed inject bin, and the PROVENANCE schema change.
- [ ] PR opened with a clear summary linking back to the spec.
- [ ] CI green.
- [ ] Merged via rebase, branch deleted local + remote.

**Verification:** `git log origin/main..` shows zero commits ahead after merge.

**Dependencies:** Task 1.5.

**Files likely touched:** `CHANGELOG.md`.

**Scope:** XS.

### Section 1 risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Pre-PR-#153 source SHA can't be located in main-repo history (force-push, history surgery) | low | high | Task 1.1 verifies before Task 1.2 commits. If source is gone, HALT and escalate to Jim — reconstruction from the bundled JS is possible but multi-hour work outside this plan's scope. |
| Rebuilt bundle behaviourally differs from the committed bytes (esbuild version drift) | medium | low | Smoke suite (Task 1.4) is the gate. If smoke fails, debug before Task 1.5. |
| Hand-edits exist in the committed bundles that aren't in the retired source | low | medium | Hash-validation in CI would have prevented them. If smoke fails on Task 1.4, this is one suspect — diff the bundles. |
| TypeScript `.mts` resolver issues on older Node versions on user machines | medium | low | Worst case: convert to `.mjs` in a follow-up. Not a hard blocker. |

### Checkpoint: end of Section 1

- [ ] One PR merged in `the-librarian-claude-plugin`.
- [ ] `scripts/build-bundle.mjs` runs without any cross-repo path resolution.
- [ ] All three committed bins (lifecycle hook, mcp-call, conv-state inject) are hash-validated against PROVENANCE.
- [ ] Smoke suite green.
- [ ] **Optional eyeball test:** install the new plugin version locally; one real conversation; confirm lifecycle hooks still fire and conv-state injection still produces the canonical block.

---

## Section 2 — Pi extension conv-state injection

**Spec:** [`026-pi-extension-conv-state-injection-spec.md`](./026-pi-extension-conv-state-injection-spec.md).
**Working tree:** `~/code/the-librarian-pi-extension`.
**Output:** one PR in `the-librarian-pi-extension` merged to main.

Sequenced second because: lowest implementation risk in the injection family (stable namespace, SDK-blessed pattern with five canonical examples to mirror), gives us a clean reference implementation before tackling the higher-risk opencode equivalent.

### Task 2.1 — Add `convStateGet` to the vendored MCP client

**Description:** Extend `extensions/librarian/vendor/mcp-client.ts` (or `.js` — match what's there) with a `convStateGet(convId: string, timeoutMs: number)` helper. Same shape as the existing tool helpers; uses the existing HTTP transport; respects the existing token + endpoint config.

**Acceptance criteria:**
- [ ] New exported function `convStateGet(convId, timeoutMs)` returns a parsed conv_state row or `null`.
- [ ] On HTTP error, timeout, or parse error: returns `null`, logs to the sidecar log.
- [ ] On `"No conversation state for conv_id ..."` text response: returns `null` (treated as miss).

**Verification:** unit test for the helper. Test cases: hit (valid JSON), miss ("No conversation state ..." text), timeout (rejects within budget), HTTP 500 (returns null).

**Dependencies:** none.

**Files likely touched:** `extensions/librarian/vendor/mcp-client.ts`, `tests/mcp-client.test.ts`.

**Scope:** S.

### Task 2.2 — Add the canonical block renderer

**Description:** New file `extensions/librarian/conv-state-render.ts` exporting `renderConvStateBlock(state)`. Byte-identical with the other four plugins' implementations (per AGENTS.md §2 five-peer-implementations rule).

**Acceptance criteria:**
- [ ] Renders the canonical block from spec §4.9 exactly: `<conversation-state>\n  conv_id: ...\n  domain: ...\n  session_id: ...\n  off_record: ...\n</conversation-state>`.
- [ ] `null` input returns the empty string.
- [ ] Output is byte-identical to the existing implementations in Hermes/Codex/Claude plugins.

**Verification:** snapshot test against a fixture state object. The snapshot should match a captured string from one of the other plugins' equivalent tests.

**Dependencies:** none.

**Files likely touched:** `extensions/librarian/conv-state-render.ts`, `tests/conv-state-render.test.ts`.

**Scope:** XS.

### Task 2.3 — Implement the `before_agent_start` handler

**Description:** New file `extensions/librarian/handlers/system-prompt-augment.ts` exporting a function that registers the `before_agent_start` hook. The handler:
1. Reads privacy state via the orchestrator. If off-record, return undefined (silent).
2. Derives `convId = pi:${pi.getSessionName()}`. If `getSessionName()` returns undefined, return undefined.
3. Calls `convStateGet(convId, 500)`. If null, return undefined.
4. Returns `{ systemPrompt: event.systemPrompt + "\n\n" + renderConvStateBlock(state) }`.

All error paths return undefined (silent). Any unexpected throw is caught, logged, and converted to silent return.

**Acceptance criteria:**
- [ ] Handler is registered via `pi.on("before_agent_start", ...)`.
- [ ] Wired into `extensions/librarian/index.ts` alongside the existing handlers.
- [ ] No existing handlers modified.

**Verification:** four test cases covering the four branches (hit, miss, throw, off-record). See Task 2.4.

**Dependencies:** Tasks 2.1, 2.2.

**Files likely touched:** `extensions/librarian/handlers/system-prompt-augment.ts` (new), `extensions/librarian/index.ts`.

**Scope:** S.

### Task 2.4 — Tests for the handler

**Description:** Four-case test suite covering the handler's branches. Test cases:
1. State hit: `convStateGet` returns a state object; handler returns `{ systemPrompt: <input> + "\n\n" + <block> }`.
2. No state: `convStateGet` returns null; handler returns undefined.
3. Network failure: `convStateGet` throws; handler returns undefined; error logged.
4. Off-record: privacy gate suppresses; `convStateGet` is NEVER called; handler returns undefined.

**Acceptance criteria:**
- [ ] All four test cases pass.
- [ ] Test #4 explicitly asserts the MCP client mock has zero `convStateGet` calls (privacy gate verified).
- [ ] Test #1 asserts the returned `systemPrompt` matches `event.systemPrompt + "\n\n" + renderConvStateBlock(<state>)` exactly.

**Verification:** `bun test tests/system-prompt-augment.test.ts` — all four pass.

**Dependencies:** Task 2.3.

**Files likely touched:** `tests/system-prompt-augment.test.ts` (new).

**Scope:** S.

### Task 2.5 — CHANGELOG + PR + eyeball-test gate + merge

**Description:** CHANGELOG entry under `## [Unreleased]`. Push branch, open PR, watch CI. **Before merging:** eyeball test against a real Pi session. In a real Pi session connected to a Librarian with a seeded conv_state row for the Pi session's name, ask the model a question that requires the conv-state context to answer (e.g. "what domain is this conversation in?"). Verify the model answers correctly. Only after that passes, merge via rebase.

**Acceptance criteria:**
- [ ] CHANGELOG entry under `## [Unreleased]`.
- [ ] PR opened with a clear summary linking back to the spec.
- [ ] CI green.
- [ ] Eyeball test passed (operator-confirmed).
- [ ] Merged via rebase; branch deleted local + remote.

**Verification:** post-merge, the extension can be locally installed and a fresh conversation receives the block (mirror of the eyeball test).

**Dependencies:** Task 2.4. **Halt gate:** eyeball-test failure blocks merge.

**Files likely touched:** `CHANGELOG.md`.

**Scope:** XS (work) + manual eyeball check.

### Section 2 risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `before_agent_start` doesn't actually fire per-turn in some Pi mode (RPC, print, scripted) | low | medium | Task 2.5's eyeball test gates this. If injection doesn't reach the model, debug before merge. |
| SDK `^0.75.5` bump introduces signature change | low | low | `tsc --noEmit` in CI catches it. |
| Pi session name is unstable across reloads → conv-id mismatches between sessions | low | low | The existing extension already uses `pi.getSessionName()` for source_ref derivation, so it's already trusted as stable. If problems surface, the conv-id format could be widened to include cwd. |

### Checkpoint: end of Section 2

- [ ] One PR merged in `the-librarian-pi-extension`.
- [ ] Handler + renderer + mcp-client extension all committed.
- [ ] Tests green.
- [ ] Eyeball test confirmed injection works in a real session.

---

## Section 3 — opencode conv-state injection

**Spec:** [`025-opencode-conv-state-injection-spec.md`](./025-opencode-conv-state-injection-spec.md).
**Working tree:** `~/code/the-librarian-opencode-plugin`.
**Output:** one PR in `the-librarian-opencode-plugin` merged to main.

Sequenced third because: nearly identical implementation shape to Section 2, but with the residual #17100 silent-discard risk that needs the eyeball test to mitigate. Doing Pi first means we have a known-good reference for the patterns; only the hook surface differs.

### Task 3.1 — Add `convStateGet` to the MCP client

**Description:** Extend `src/mcp-client.ts` with `convStateGet(convId, timeoutMs)` — same shape as the Pi extension's Task 2.1.

**Acceptance criteria:** same shape as Task 2.1.

**Verification:** same shape as Task 2.1.

**Dependencies:** none.

**Files likely touched:** `src/mcp-client.ts`, `tests/mcp-client.test.ts`.

**Scope:** S.

### Task 3.2 — Add the canonical block renderer

**Description:** New file `src/conv-state-render.ts`. Byte-identical with the other four plugins' implementations (including the just-landed Pi version from Section 2). Snapshot test asserts exact match.

**Acceptance criteria:** same shape as Task 2.2.

**Verification:** snapshot test passes; capture cross-checked against Pi's renderer output.

**Dependencies:** none.

**Files likely touched:** `src/conv-state-render.ts`, `tests/conv-state-render.test.ts`.

**Scope:** XS.

### Task 3.3 — Implement the `experimental.chat.system.transform` handler

**Description:** New file `src/handlers/system-transform.ts`. Hook handler registered against `experimental.chat.system.transform`. The handler:
1. Guards on `input.sessionID` — absent → silent return.
2. Reads privacy state via the existing `state-store.ts`. Off-record → silent return.
3. Derives `convId = opencode:${input.sessionID}`.
4. Calls `convStateGet(convId, 500)`. Null → silent return.
5. Calls `output.system.push(renderConvStateBlock(state))`.

All error paths are caught and result in silent no-mutation of `output.system`. The SDK's safety-fallback restores the original system array if a plugin empties it, so we never break a user session.

**Acceptance criteria:**
- [ ] Handler registered in `src/index.ts`'s `Hooks` return.
- [ ] Existing handlers (`chat.message`, `session.created`, etc.) untouched.
- [ ] Push pattern matches the spec's §4.2 code sketch.

**Verification:** four test cases — see Task 3.4.

**Dependencies:** Tasks 3.1, 3.2.

**Files likely touched:** `src/handlers/system-transform.ts` (new), `src/index.ts`.

**Scope:** S.

### Task 3.4 — Tests for the handler

**Description:** Four-case test suite covering the handler's branches. Same four cases as Pi's Task 2.4 (hit, miss, throw, off-record), adapted to opencode's input/output shape (`{ sessionID, model }` input, `{ system: string[] }` output).

**Acceptance criteria:** same shape as Task 2.4, with hit assertion checking that `output.system` ends with the appended block.

**Verification:** `bun test tests/system-transform.test.ts` — all four pass.

**Dependencies:** Task 3.3.

**Files likely touched:** `tests/system-transform.test.ts` (new).

**Scope:** S.

### Task 3.5 — CHANGELOG + PR + eyeball-test gate + merge

**Description:** CHANGELOG under `## [Unreleased]`. Push branch, open PR, CI. **Before merging: mandatory eyeball-test gate per spec §7 step 4** — the residual #17100 silent-discard mitigation. In a real opencode session with a seeded conv_state row, ask the model "what domain is this conversation in?" — verify correct answer. If the model can't answer correctly, we've hit #17100; HALT and escalate upstream with a fresh repro.

**Acceptance criteria:** same shape as Task 2.5, plus the explicit #17100 gate.

**Verification:** eyeball test PASSED. If it FAILED, HALT — do not merge.

**Dependencies:** Task 3.4. **Halt gate:** eyeball-test failure blocks merge AND triggers upstream-issue follow-up.

**Files likely touched:** `CHANGELOG.md`.

**Scope:** XS (work) + manual eyeball check.

### Task 3.6 — Document the monitoring plan in plugin AGENTS.md

**Description:** Per spec §7.1, the four-mechanism monitoring plan needs to live in the plugin's `AGENTS.md` so future maintainers inherit it. Add a new section under §2 (or a fresh §) listing the four mechanisms: pinned SDK + CI typecheck, CHANGELOG grep on bumps, namespace-graduation watch, quarterly eyeball re-test.

**Acceptance criteria:**
- [ ] `AGENTS.md` includes the four-mechanism plan.
- [ ] Cross-references the spec section.

**Verification:** human review only. No automated check.

**Dependencies:** Task 3.5.

**Files likely touched:** `AGENTS.md`.

**Scope:** XS.

### Section 3 risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Issue #17100 silent-discard bites our use case | unknown | high | Task 3.5's eyeball test gates merge. If hit, escalate upstream; this plan halts at Task 3.5 until resolved. |
| `experimental.*` namespace graduation between now and the next SDK bump | low | low | Task 3.6 commits us to watching for it; the worst case is a one-day re-wire. |
| Tag-search for hook name in CHANGELOG misses a deprecation announcement | low | medium | Task 3.6's mechanism #2 + the eyeball re-test schedule (mechanism #4) provide defence in depth. |

### Checkpoint: end of Section 3

- [ ] One PR merged in `the-librarian-opencode-plugin`.
- [ ] Handler + renderer + mcp-client extension committed.
- [ ] Tests green.
- [ ] Eyeball test confirmed injection works in a real session (silent-discard #17100 doesn't bite).
- [ ] Monitoring plan documented in plugin AGENTS.md.

---

## Section 4 — Classifier implementation (split into 4a / 4b / 4c / 4d)

**Spec:** [`023-classifier-implementation-spec.md`](./023-classifier-implementation-spec.md).
**Working tree:** `~/code/the-librarian` (main repo).
**Output:** **four sequential PRs in `the-librarian`** (was: one collapsed PR per parent spec §7.3 — re-split below). Each PR merges to main before the next starts.

### Why the split

The original plan called for one PR collapsing the classifier work with the parent-spec category-drop. That bundle is ~30–40 file changes across new packages, an async worker, dashboard work, a migration backfill of real user data, and two halt gates. The open-question in the original draft already flagged "split into PR 6a / 6b" as a defensible alternative; this revision commits to that split (with four parts rather than two, to also isolate the local-provider risk and the dashboard surface).

Split by **risk and reversibility**:

- **4a — Classifier foundation (no behavior change).** Truly additive: new package, schema bump, async worker scaffold. The remember tool is **not** rewired here; `deriveLegacyMemoryFlags` stays as the source of truth for new memories. Zero risk to existing data; zero agent-visible change. Backwards-compatible.
- **4b — Local provider via node-llama-cpp.** Isolated to the classifier package. New runtime dependency (`node-llama-cpp`) gated behind an opt-in `peerDependencyMeta` so installs without local mode don't pull it. Worker-thread architecture.
- **4c — Dashboard eval surface.** Operator-facing CLI + dashboard page. No production data effect; reads memories and runs evals, doesn't mutate. Optional public synthetic fixture generation (Task 4.10).
- **4d — Behavior cutover + migration backfill (halt-gated).** The risky one: `remember` switches to the new worker path, `deriveLegacyMemoryFlags` is removed, existing memories are backfilled, and the `category` / `visibility` / `scope` columns are dropped (parent-spec collapse). Halt gates from the original plan (4.8 + 4.11) apply here.

Sections 4a/4b/4c can each land independently of each other; 4d depends on 4a (and ideally 4c for visibility into the backfill).

### Cross-cutting acceptance for each Section-4 PR

- [ ] `pnpm test` green across the workspace.
- [ ] `pnpm typecheck` green.
- [ ] Schema-snapshot fingerprint refreshed if columns or `PROJECTION_SCHEMA_VERSION` changed.
- [ ] CHANGELOG entry under `## [Unreleased]` covering the slice this PR shipped.
- [ ] Plan revisited; this `Section 4` header updated as each sub-section lands.

---

## Section 4a — Classifier foundation (no behavior change)

**PR scope:** truly additive. New workspace package, schema bump, remote provider, async worker scaffold. The worker is wired but operates only on memories that already have `classified=0` — and since no code path **sets** `classified=0` yet, the worker is effectively dormant in production. `remember` is **unchanged** here; the legacy `deriveLegacyMemoryFlags` bridge stays as the source of truth for new memories. Backwards-compatible.

**Tasks bundled:** 4.1, 4.2, 4.4, 4.5.

**Acceptance:**
- [ ] New `@librarian/classifier` package builds, typechecks, tests.
- [ ] `memories` table has the two new columns (`classified`, `classification_attempts`) after a fresh boot.
- [ ] `PROJECTION_SCHEMA_VERSION` bumped to 15; schema-snapshot fingerprint refreshed.
- [ ] Remote provider classifies a synthetic input correctly in a unit test (mocked LLM client).
- [ ] Async worker module exists, has its state-machine tests, but is **inert** in production until 4d wires it.
- [ ] No agent-visible behavior change. Existing memories unchanged; new memories continue to flow through `deriveLegacyMemoryFlags`.

**Halt gates:** none.

### Task 4.1 — `@librarian/classifier` package skeleton

**Description:** Create new workspace package `packages/classifier/`. Initial structure: `src/index.ts` exporting placeholder `classify({title, body, tags}, providerConfig)`; `src/prompts/v1.md` with the v1 prompt from spec §4.4; `package.json` declaring `node-llama-cpp` as a `peerDependencyMeta` (optional) so installs without local mode don't pull it. Build + typecheck + tests scaffold.

**Acceptance criteria:**
- [ ] Package builds clean (`pnpm --filter @librarian/classifier build`).
- [ ] Exports `classify()` and `ClassifyResult` types.
- [ ] Prompt v1 committed at `src/prompts/v1.md`.

**Verification:** `pnpm --filter @librarian/classifier build && pnpm --filter @librarian/classifier test`.

**Dependencies:** none.

**Files likely touched:** `packages/classifier/package.json`, `packages/classifier/src/index.ts`, `packages/classifier/src/prompts/v1.md`, `pnpm-workspace.yaml` (add to workspace).

**Scope:** S.

### Task 4.2 — Provider abstraction + remote (OpenAI-compatible) implementation

**Description:** Implement the provider router in `@librarian/classifier`. Two providers: `local` (Task 4.3) and `remote` (this task). Remote reuses `@librarian/core/curator-llm-client` with a separate config namespace (`classifier.remote.*`). Token storage via existing `secret-crypto`. Provider config schema defined in core (`packages/core/src/schemas/classifier-config.ts`).

**Acceptance criteria:**
- [ ] `classify()` dispatches to remote when `config.provider === "remote"`.
- [ ] Remote provider calls the OpenAI-compatible endpoint with the v1 prompt; parses the JSON response.
- [ ] Parse errors fall through to the conservative-defaults verdict with `fallback_used: "parse"`.
- [ ] Timeout (30s per attempt) enforced via AbortController.

**Verification:** unit tests with a mocked LLM client. Cases: valid JSON → correct verdict; malformed JSON → conservative defaults + fallback flag; HTTP 500 → conservative defaults + `fallback_used: "provider_unavailable"`; AbortController timeout → conservative defaults + `fallback_used: "timeout"`.

**Dependencies:** Task 4.1.

**Files likely touched:** `packages/classifier/src/providers/remote.ts`, `packages/classifier/src/providers/index.ts`, `packages/core/src/schemas/classifier-config.ts`.

**Scope:** M.

---

## Section 4b — Local provider via `node-llama-cpp`

**PR scope:** isolated to the classifier package. Adds the `local` provider, the worker-thread architecture, the six-model catalog, and the custom-model self-test. Optional in production — `remote` remains the supported provider for low-spec hardware.

**Tasks bundled:** 4.3.

**Acceptance:**
- [ ] `classify({...}, { provider: "local", ... })` works end-to-end in an integration test (CI-gated behind a flag so models aren't downloaded by default).
- [ ] Worker-thread inference proven non-blocking by a concurrent-request test.
- [ ] Six-model catalog committed; custom-model self-test rejects an obviously-bad config (model that doesn't produce parseable JSON).

**Halt gates:** none.

### Task 4.3 — Local provider via `node-llama-cpp`

**Description:** Implement the `local` provider in `@librarian/classifier`. Runs the configured GGUF model on a Node worker thread to keep the mcp-server's main event loop responsive. Lazy model load on first `classify()` call. Six-model catalog committed at `src/catalog.ts` (the table from spec §4.3). Custom-model self-test prompt validates parseable JSON before persisting admin config.

**Acceptance criteria:**
- [ ] `classify()` dispatches to local when `config.provider === "local"`.
- [ ] Model loads lazily on first call; subsequent calls reuse the loaded instance.
- [ ] Inference runs on a worker thread (`worker_threads`).
- [ ] Catalog lists the six models from §4.3 with HF identifiers + recommended quant.
- [ ] Custom-model validation runs a known-good test prompt before saving config.

**Verification:** integration test against a small downloaded model (e.g. Qwen3.5-0.8B-Instruct Q4_K_M). Gated behind a flag so CI doesn't download models. Worker thread non-blocking verified by a concurrent-request test.

**Dependencies:** Task 4.1.

**Files likely touched:** `packages/classifier/src/providers/local.ts`, `packages/classifier/src/providers/local.worker.ts`, `packages/classifier/src/catalog.ts`.

**Scope:** L.

### Task 4.4 — Schema bump: new `memories` columns + worker state

**Description:** Bump `PROJECTION_SCHEMA_VERSION` to 15. Add columns: `classified INTEGER NOT NULL DEFAULT 0` and `classification_attempts INTEGER NOT NULL DEFAULT 0` to `memories`. Refresh the schema-snapshot fingerprint via `scripts/check-schema-version.mjs --update`.

**Acceptance criteria:**
- [ ] Both columns exist on `memories` after a fresh boot.
- [ ] Existing memories migrate to `classified=0, classification_attempts=0` (default values apply during projection rebuild).
- [ ] `scripts/check-schema-version.mjs` passes.

**Verification:** unit test in `packages/core/tests/store/projection.test.ts` verifying the column existence and defaults; full `pnpm test`.

**Dependencies:** none — can run in parallel with Tasks 4.1–4.3.

**Files likely touched:** `packages/core/src/store/projection.ts`, `test/schema-snapshot.json`, `packages/core/tests/store/projection.test.ts`.

**Scope:** S.

### Task 4.5 — Async worker (drains the projection queue)

**Description:** New module in `@librarian/mcp-server` or a dedicated package. Worker polls `SELECT id FROM memories WHERE classified=0 ORDER BY created_at LIMIT 1` every 500ms when idle, back-to-back when busy. For each row: call `classify()`, update the row with the verdict (+ flip `classified=1`), emit a `memory.classified` event to `events.jsonl`. On failure: increment `classification_attempts`. After 3 failed attempts: mark `classified=1` with conservative defaults + emit `memory.classified` with `fallback_used: "max_retries"`. Single worker instance per mcp-server process.

**Acceptance criteria:**
- [ ] Worker polls the projection without blocking other MCP calls.
- [ ] Successful classification updates the row's booleans + emits the event.
- [ ] 3-retry-then-giveup logic enforced.
- [ ] Crash mid-classification leaves the row at `classified=0` for next iteration (verified by a test that simulates a crash).

**Verification:** end-to-end test: insert a memory at `classified=0`; start the worker; verify the row reaches `classified=1` with a valid verdict; verify exactly one `memory.classified` event in the ledger; assert `attempts=0` on success. Separate test for the 3-retry-giveup path using a deterministically-failing mock classifier.

**Dependencies:** Tasks 4.1, 4.4.

**Files likely touched:** `packages/mcp-server/src/classifier-worker.ts`, `packages/mcp-server/src/index.ts` (wire startup), tests.

**Scope:** M.

### Checkpoint: end of 4a

- [ ] `pnpm test` green across the workspace.
- [ ] `pnpm typecheck` green.
- [ ] Schema-snapshot fingerprint refreshed.
- [ ] Classifier package + provider router + async worker all in place but **not yet wired into `remember`** — the existing PR 1 `deriveLegacyMemoryFlags` bridge is still the source of truth at this checkpoint.
- [ ] No agent-visible behaviour change yet.

---

## Section 4c — Dashboard eval surface

**PR scope:** operator-facing eval CLI + dashboard page. No effect on production data — reads memories and runs evals, does not mutate. Optional companion: the one-shot public synthetic fixture generation (Task 4.10) can either land here or in a follow-up.

**Tasks bundled:** 4.7, 4.10 (optional).

**Acceptance:**
- [ ] `eval run --provider remote --model gpt-4o-mini --sample 10 --category boundary` returns a deterministic JSON report against a fixture.
- [ ] Dashboard page renders the form, runs the eval, displays the results with sample-level diffs.
- [ ] Soft-alert banner when `fallback_used: "max_retries"` rate exceeds 20% over the last 100 classifications.
- [ ] If Task 4.10 lands here: `packages/classifier-eval/fixtures/public-v1.json` present with ~900 entries.

**Halt gates:** none. Task 4.10's multi-model consensus generation may need an explicit API budget but is otherwise straight code.

---

## Section 4d — Behavior cutover + migration backfill (halt-gated)

**PR scope:** **the risky one.** Switch `remember` to the worker path, remove `deriveLegacyMemoryFlags`, backfill existing memories, drop `category` / `visibility` / `scope` columns (parent-spec §7.3 collapse). Must land after 4a; ideally after 4c (so the dashboard can surface backfill progress).

**Tasks bundled:** 4.6, 4.8, 4.9, 4.11.

**Acceptance:**
- [ ] `remember` returns "Memory saved" in <50ms p99 with rows landing at conservative defaults.
- [ ] Migration script (idempotent) marks all existing memories `classified=0`; worker drains the queue post-merge.
- [ ] `Category` / `Visibility` / `Scope` enums and `PROTECTED_CATEGORIES` removed from `@librarian/core/schemas/common.ts`; dashboard category surfaces migrated.
- [ ] Pre-merge dry-run on a copy of the canonical instance.
- [ ] First-24h backfill monitoring shows `fallback_used: "max_retries"` rate < 5%.

**Halt gates (from original plan):**
- **Task 4.8 halt gate:** migration produces inconsistent state (some memories unclassifiable or unwritable). Halt and escalate.
- **Task 4.11 halt gate:** post-merge backfill produces > 20% max-retries-giveup rate on the first 100 memories. Signals model misconfiguration or systemic issue. Halt and roll back.

### Task 4.6 — Integrate `remember` with the async worker

**Description:** Update `packages/mcp-server/src/mcp/tools/remember.ts` so new memories land with conservative defaults (`requires_approval=true, is_global=false, classified=0`). Remove the call into `deriveLegacyMemoryFlags`. Agent response remains "Memory saved" regardless of classification state.

**Acceptance criteria:**
- [ ] `remember` returns "Memory saved" in <50ms p99 (no classifier blocking the agent).
- [ ] Memory rows land at conservative defaults; classifier worker picks them up.
- [ ] The deriveLegacyMemoryFlags bridge is removed from the call path (but the helper function stays callable for the migration in Task 4.8).

**Verification:** existing `remember` tests updated; new test asserting `classified=0, classification_attempts=0` on freshly-written memories before the worker runs.

**Dependencies:** Task 4.5.

**Files likely touched:** `packages/mcp-server/src/mcp/tools/remember.ts`, `packages/mcp-server/tests/`.

**Scope:** S.

### Task 4.7 — Dashboard evaluation page + CLI

**Description:** New `@librarian/classifier-eval` package with the CLI commands from spec §4.6 (`eval run`, `eval replay`, `eval generate-fixture`). New Next.js page at `apps/dashboard/app/(memories)/classifier-eval/page.tsx` with the dashboard surface described in spec §4.6: pick provider + model + sample size + category filter; run; display results table with disagreement diffs; each run emits a `classifier.evaluation_completed` event.

**Acceptance criteria:**
- [ ] CLI: `eval run --provider remote --model gpt-4o-mini --sample 10 --category boundary` returns a JSON report on stdout.
- [ ] Dashboard page renders the form; submitting runs the eval via the CLI surface; results render as a table with sample-level diffs.
- [ ] Each run appends a `classifier.evaluation_completed` event to `events.jsonl`.
- [ ] Soft-alert recommendation from §4.3 implemented: dashboard surfaces a warning banner when `fallback_used: "max_retries"` rate exceeds 20% over the last 100 classifications.

**Verification:** component test for the dashboard page (mocked CLI); CLI integration test against a mocked classifier. Eval generates a deterministic report against a small fixture for the test.

**Dependencies:** Task 4.5.

**Files likely touched:** `packages/classifier-eval/` (new package), `apps/dashboard/app/(memories)/classifier-eval/page.tsx`, `apps/dashboard/components/classifier-eval/`, related actions + tests.

**Scope:** L.

### Task 4.8 — Migration: backfill existing memories

**Description:** Update `scripts/migrate-add-domain-and-conv-state.mjs` (or new sibling script) to mark all existing memories with `classified=0, classification_attempts=0` on first boot post-merge. Worker drains the queue in the background over the first hours/days. The dashboard's classifier-eval page lets the operator monitor the backfill progress.

**Acceptance criteria:**
- [ ] Migration script idempotent: re-running produces the same state.
- [ ] All pre-existing memories enter the worker queue at upgrade time.
- [ ] Migration logs counts: memories enqueued for classification, memories skipped (already classified).
- [ ] **The category-derived bridge code (`deriveLegacyMemoryFlags`) is deleted in the same PR** — the worker is now the only source of `is_global` / `requires_approval` for new and migrated memories.

**Verification:** migration test against a fixture JSONL containing PR 1-era memories. Verify post-migration row counts, classified-status distribution, and that the helper is no longer reachable from the active code path.

**Dependencies:** Task 4.6.

**Files likely touched:** `scripts/migrate-add-domain-and-conv-state.mjs`, `packages/core/src/constants.ts` (remove `deriveLegacyMemoryFlags`), `packages/core/src/store/memory-store.ts` (remove the legacy path).

**Scope:** M.

### Task 4.9 — Parent-spec collapse work + CHANGELOG + docs

**Description:** Per parent spec §7.3 (just updated in PR #172), PR 6 + PR 7 collapse here. This task implements the previously-PR-7 work in the same PR: drop the `category`, `visibility`, `scope` columns from `memories` (re-run the migration's tag-conversion logic); remove the `Category`, `Visibility`, `Scope` enums and `PROTECTED_CATEGORIES` from `@librarian/core/schemas/common.ts`; remove all the dashboard surfaces that grouped by `category`. CHANGELOG entry. Bump `PROJECTION_SCHEMA_VERSION` again if column drops happen here.

**Acceptance criteria:**
- [ ] After this task, `memories` table has no `category`, `visibility`, `scope` columns.
- [ ] `@librarian/core/schemas/common.ts` no longer exports those enums.
- [ ] Dashboard surfaces have been migrated off category-grouped views.
- [ ] CHANGELOG entry under `## [Unreleased]` covers the full classifier + cutover scope.
- [ ] All tests pass; `pnpm typecheck` passes.

**Verification:** full `pnpm test`; `node scripts/check-schema-version.mjs` succeeds; dashboard manual walkthrough confirms no remaining category UI.

**Dependencies:** Task 4.8.

**Files likely touched:** broad — `packages/core/src/schemas/common.ts`, `packages/core/src/schemas/memory.ts`, `packages/mcp-server/src/mcp/tools/*.ts`, `apps/dashboard/**`, `scripts/migrate-add-domain-and-conv-state.mjs`, `test/schema-snapshot.json`, `CHANGELOG.md`.

**Scope:** L (touches many files but each touch is small).

### Task 4.10 — Public synthetic fixture generation (one-shot pre-merge)

**Description:** Per spec §4.7, generate the public synthetic fixture: ~1500 candidates with 60/40 straight/boundary, multi-model consensus filter (Claude + GPT-4o + Gemini, unanimous), trim to ~900 maintaining the ratio. Commit to `packages/classifier-eval/fixtures/public-v1.json`. This is a one-shot operation — not part of the runtime workflow.

**Acceptance criteria:**
- [ ] Fixture file exists at the expected path with ~900 entries.
- [ ] Each entry: `{id, title, body, tags, label: {requires_approval, is_global}, category: "straight" | "boundary", consensus_models: [...]}`.
- [ ] Provenance comment in the fixture file lists the generator models + date.
- [ ] CHANGELOG records which models produced it.

**Verification:** the dashboard eval CLI (`eval run --sample 50`) against the new fixture produces a valid report.

**Dependencies:** Task 4.7. Optional: this could land in a follow-up PR if API rate limits or operator time-of-day make a single-session generation impractical.

**Files likely touched:** `packages/classifier-eval/fixtures/public-v1.json`, `CHANGELOG.md`.

**Scope:** M (mostly waiting on API calls; minimal code).

### Task 4.11 — PR + CI + monitor backfill + merge

**Description:** Push branch, open PR, watch CI. **After merge:** monitor the backfill on the canonical instance for the first 24 hours. Verify worker is draining; verify classifier verdicts match expectations on real memories; address any anomalies before declaring the rollout complete.

**Acceptance criteria:**
- [ ] PR opened with full summary referencing the classifier spec and the §7.3 parent-spec collapse.
- [ ] CI green across all jobs.
- [ ] Merged via rebase.
- [ ] First-24h backfill monitoring shows: worker draining at expected pace; `fallback_used: "max_retries"` rate < 5% (anything higher is a model-quality red flag).

**Verification:** dashboard eval page shows backfill complete (all memories `classified=1`); spot-check 20 memories against gut-feel expectations.

**Dependencies:** Tasks 4.1–4.10.

**Files likely touched:** `CHANGELOG.md`.

**Scope:** XS (work) + monitoring observation.

### Section 4 risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Backfill produces classifier verdicts wildly different from category-derived booleans | medium | high | Visible on day one. Owner reviews dashboard; if calibration is off, owner overrides via the dashboard or we roll back the PR. |
| node-llama-cpp doesn't build cleanly on one of the supported platforms | medium | medium | Task 4.3's integration test gates this. If a platform fails, ship remote-mode default for that platform; local-mode is opt-in. |
| Worker thread + main event loop interaction is fragile under concurrent MCP calls | medium | medium | Task 4.5's concurrent-request test gates this. If it fails, fall back to single-threaded sequential drain (slower but correct). |
| Public fixture generation fails partway through due to API rate limits | medium | low | Task 4.10 can land in a follow-up PR. The dashboard eval still works against an empty fixture (no eval data, but page renders). |
| Removing the legacy bridge breaks something we forgot about | low | high | Task 4.9's full test suite + typecheck gates. Pre-merge dry-run on a copy of the canonical instance recommended. |

### Checkpoint: end of Section 4

- [ ] PR merged in the main repo.
- [ ] Schema at v15 (or higher if Task 4.9 added another bump).
- [ ] Classifier worker running; backfill complete or progressing visibly.
- [ ] Dashboard classifier-eval page operational; one full eval run completed.
- [ ] Public fixture committed (or follow-up PR scheduled).
- [ ] Category-derived bridge code deleted; `Category`/`Visibility`/`Scope` enums removed.
- [ ] CHANGELOG entry covers the full classifier + cutover scope.

---

## Overall checkpoints + verification

### Halt gates (the autonomous build must stop and ask Jim if any of these trip)

1. **Task 1.1**: pre-PR-#153 SHA not locatable in main-repo history.
2. **Task 2.5**: Pi eyeball test fails (handler doesn't reach the model).
3. **Task 3.5**: opencode eyeball test fails (issue #17100 confirmed in our use case).
4. **Task 4.8 (Section 4d)**: migration produces inconsistent state (some memories unclassifiable or unwritable).
5. **Task 4.11 (Section 4d)**: post-merge backfill produces > 20% max-retries-giveup rate on the first 100 memories (signals model misconfiguration or systemic issue).

Sections 4a–4c have no halt gates; they're additive / no-data-effect / operator-facing. 4d is the only Section-4 PR where the halt gates apply.

### Per-section verification checklist

After each section's PR merges:

- [ ] CI on the merged branch passed.
- [ ] Local clone of the merged main is up to date.
- [ ] No uncommitted changes.
- [ ] Subsequent section's working tree is clean.

### Final acceptance (end of Section 4)

- [ ] All four sections' PRs merged.
- [ ] Memory-domain-isolation rollout is complete (PR 1 + PR 2 + PR 3 + PR 4 + PR 5 + PR 6 + PR 7-docs).
- [ ] Classifier active in the canonical instance; backfill complete.
- [ ] All five plugins have conv-state injection (claude/codex/hermes already; opencode/pi added by this plan).
- [ ] No spec is left without a corresponding implementation.

---

## Open questions

- **Public fixture generation API budget.** Multi-model consensus over 1500 candidates × 3 models = ~4500 API calls. At ~$0.001/call this is ~$5 — trivial. But rate limits may add real time. Worth checking before Task 4.10 starts.
- **Backfill duration on the canonical instance.** ~200 existing memories × p99 inference time. With Qwen3.5-0.8B Q4 on a laptop: maybe 5 seconds each = ~17 minutes total. With LFM2.5-1.2B-Instruct: maybe 15 seconds each = ~50 minutes. Order-of-magnitude estimates; first-day-of-Section-4 reality.
- **Dashboard eval CLI vs in-process implementation.** Spec says CLI; the dashboard could equivalently call into `@librarian/classifier-eval` as an in-process API. CLI is simpler for the eval-from-scripting case; in-process is simpler for the dashboard case. Task 4.7 should pick one and stick with it (recommendation: CLI, mirroring the existing `@librarian/cli` pattern).
- **Whether Section 4 should land as a single PR or be further split.** As written, the section produces one big PR (~30-40 file changes). Could be split into PR 6a (new packages + worker + remember integration) and PR 6b (dashboard eval + migration backfill + parent-spec collapse). I'd default to one PR for atomicity but if review feedback says split, we split.

---

## Verification before starting

- [ ] All four specs read and approved (already done — they're on `main`).
- [ ] Dependency graph confirms section order (sequential, no cycles).
- [ ] Halt gates acknowledged.
- [ ] Working trees identified per section: `~/code/the-librarian-claude-plugin`, `~/code/the-librarian-pi-extension`, `~/code/the-librarian-opencode-plugin`, `~/code/the-librarian`.
- [ ] Reviewed with Jim before starting Section 1.

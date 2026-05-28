# Implementation plan: classifier dashboard config

Companion to
[`classifier-dashboard-config-spec.md`](./classifier-dashboard-config-spec.md).
This plan covers the **how** — task slicing, dependency order, the
ambiguities the spec deferred (shutdown ordering, worker registry,
hash function, token rotation, self-test isolation), risks, and
checkpoints.

## Overview

Five vertical slices, executed in order:

1. **Shared LLM-connection helper** in `@librarian/core` (curator + new
   classifier both consume it).
2. **Classifier-config module** + tests in `@librarian/core`.
3. **Boot/restart machinery** in `@librarian/mcp-server`: worker
   registry, store-driven `bootClassifierWorker`, restart mutex,
   self-test invocation. Env contract is retired here.
4. **tRPC surface** exposing config / workerState / restart / selfTest
   procedures.
5. **Dashboard cockpit** at `/classifier`, nav + palette wiring, e2e
   smoke.

Each slice ships in its own PR, runs the full test suite, and is
reviewable in isolation. The final PR closes the spec.

## Architecture decisions

### A1. Shared helper is `core/llm-connection.ts`, not a class

A pure-function module keyed by an injected key prefix (`"curator.llm"`
or `"classifier.llm"`). No class hierarchy, no inheritance, no per-
caller subclass to maintain. The curator and classifier modules each
compose the helper with their own additional fields. This matches the
existing curator-config style and keeps the store reader/writer slices
narrow.

### A2. Curator refactors onto the helper in the same plan

Trade-off: bigger blast radius (curator is in production), but the
shared helper would otherwise carry a duplicate-curator-shape ghost
indefinitely. The mitigation is that the existing
`curator-config.test.ts` is the canary — it must keep passing
unmodified. We do the curator refactor in Slice 1 alongside the helper
so the helper has two real consumers from day one (and the test
discovers any leakage immediately). If Slice 1 risks blow up,
Slice 1.5 (curator rollback) is documented under Risks.

### A3. The worker handle lives in a process-local registry

`classifier-startup.ts` currently returns the `BootedClassifierWorker`
to the boot caller (mcp-server's `index.ts`). For restart, the tRPC
handler also needs to reach it. We add a module-scoped registry inside
`classifier-startup.ts` (`currentlyRunning: BootedClassifierWorker |
null`) plus exported `getRunningClassifierWorker()` and
`restartClassifierWorker(store)` functions. The registry is the single
mutable handle the rest of the process touches.

### A4. Local-provider lifecycle handle is captured outside `createClassifier`

`createClassifier({ provider: "local", … }, { inferenceFor })` calls
`inferenceFor` internally and the returned
`LocalInferenceClientWithLifecycle` is lost — there's no way to
`terminate()` the worker thread later. Fix: the boot path constructs
the lifecycle client **first**, holds it in the registry next to the
`ClassifierWorker`, and passes `() => client` to `createClassifier`.

```ts
// Boot path (slice 3)
const localClient = createWorkerInferenceClient({ modelId, quant });
const classifier = createClassifier(
  { provider: "local", modelId, quant },
  { inferenceFor: () => localClient },
);
const worker = createClassifierWorker({ db, classifier, appendEvent });
worker.start();
return { worker, classifier, lifecycle: { terminate: () => localClient.terminate() } };
```

Remote provider has no lifecycle handle — `lifecycle.terminate` is a
no-op there.

### A5. Restart mutex is a single in-process Promise

Single-process Node server, no clustering. A module-scoped
`restartInFlight: Promise<RestartOutcome> | null`; the tRPC handler
awaits it if non-null and returns `{ outcome: "already_in_progress" }`
instead of starting a second restart. Cleared on resolution.

### A6. Drain semantics for `worker.stop()` during restart

`worker.stop()` already waits for the in-flight `tick()` iteration
to finish — there's no built-in deadline. For restart, **we accept
unbounded drain** in v1: a classify call against a hung provider can
delay restart, but that's the same failure mode the existing boot
inherits, and the existing classify call already has its own
`timeoutMs` (60s default) per `classifier-config`. We log a warning
when drain exceeds 30s but do not force-kill. If this causes pain in
practice, a later PR can add a `forceTerminate` escape hatch.

### A7. Config hash excludes the token plaintext, includes its encrypted blob

`hasToken` boolean alone is insufficient — rotating the token
(setSetting same key with a new value) leaves `hasToken=true` and
would not trigger drift. The hash includes the *encrypted* token blob
fetched via `getSetting(token_key)` (still encrypted at that layer —
the master key is never touched here) so any token change is detected.
The hash is computed over a stable JSON serialization with sorted
keys, no whitespace, and a fixed field ordering.

### A8. Self-test runs in a transient classifier instance

The running worker is busy processing the queue; running self-test
against the same `Classifier` instance would interleave with real
work. The self-test handler builds a **fresh, standalone classifier**
from the current stored config, runs `runSelfTest()`, and discards it
(including `lifecycle.terminate()` for local provider). Self-test is
admin-gated and explicitly opt-in, so the extra model load on local
provider is the admin's choice.

### A9. The env-var hard break is enforced by absence, not by warning-only

`bootClassifierWorker(input)` no longer reads `process.env` at all.
Boot logs `classifier_env_retired` (a single structured entry) if
**any** `LIBRARIAN_CLASSIFIER_*` env is set, naming the keys, telling
the admin to use the `/classifier` cockpit. The notice runs once per
boot, regardless of whether the store config is configured.

## Dependency graph

```
slice 1: core/llm-connection.ts          ← no deps
   │
   ├─→ refactor core/curator-config.ts   (curator-config tests are canary)
   │
   └─→ slice 2: core/classifier-config.ts  ← uses llm-connection
                                            ← exports classifierConfigHash()
                                            ← exports findLegacyClassifierEnvKeys()
                  │
                  └─→ slice 3: mcp-server/classifier-startup.ts (rewrite)
                              ← exports restartClassifierWorker(store)
                              ← exports runClassifierSelfTest(store)
                              ← exports getRunningWorkerState()
                                │
                                └─→ slice 4: mcp-server/trpc/classifier-config.ts
                                        ← admin router
                                        ← AppRouter export
                                          │
                                          └─→ slice 5: apps/dashboard
                                                ← /classifier route
                                                ← components/classifier/*
                                                ← site-nav + keyboard-host
                                                ← e2e spec
```

Each arrow is "blocks." Slice 1 must land before Slice 2; Slice 2
before Slice 3; etc. Within a slice, files are usually parallelizable
(types before consumers).

## Vertical slices and task list

### Phase / Slice 1 — Shared LLM-connection helper + curator refactor

**Goal:** Land the new helper. Curator routes through it without
behaviour change.

#### Task 1.1: `core/llm-connection.ts` + tests

**Description:** Create the shared helper exactly as drafted in the
spec's code-style section.

**Acceptance criteria:**
- `LlmConnection`, `LlmConnectionPatch`, `LlmConnectionPatchSchema`,
  `llmConnectionKeys`, `readLlmConnection`, `writeLlmConnection`,
  `resolveLlmToken` all exported from `@librarian/core/index.ts`.
- Round-trip read/write of every field works.
- Token written with `{ secret: true }`; never returned by
  `readLlmConnection`.
- Key-prefix isolation: writing to `curator.llm.*` does not affect
  `classifier.llm.*` and vice versa.
- `timeoutMs` validated against `[1_000, 600_000]`.
- New tests in `packages/core/tests/llm-connection.test.ts`.

**Verification:**
- `pnpm --filter @librarian/core test:vitest tests/llm-connection.test.ts`
- `pnpm --filter @librarian/core typecheck`

**Dependencies:** None.

**Files likely touched:**
- `packages/core/src/llm-connection.ts` (new)
- `packages/core/src/index.ts` (re-exports)
- `packages/core/tests/llm-connection.test.ts` (new)

**Scope:** S (3 files).

#### Task 1.2: Refactor `curator-config.ts` onto the helper

**Description:** Replace curator's inline LLM connection plumbing with
`llmConnectionKeys("curator.llm")` + `readLlmConnection` +
`writeLlmConnection`. Curator-specific fields (`promptAddendum`,
`defaultAutoApply`, `autoApplyConfidence`, `intervalMinutes`,
`enabled`) stay inline. The public shape of `readCuratorConfig` /
`writeCuratorConfig` / `CuratorConfigPatchSchema` must not change.

**Acceptance criteria:**
- All existing `curator-config.test.ts` tests pass without
  modification.
- `CuratorConfigPatchSchema` still accepts the same patches it did
  before.
- `readCuratorConfig` returns the same shape (`{ enabled, llm:
  { provider, endpoint, model, timeoutMs }, hasToken,
  promptAddendum, defaultAutoApply, autoApplyConfidence,
  intervalMinutes, isLlmComplete, isOperational }`).
- `resolveCuratorToken` still works as the worker's decryption path.

**Verification:**
- `pnpm --filter @librarian/core test:vitest tests/curator-config.test.ts`
  (untouched suite, must pass)
- `pnpm --filter @librarian/core test:vitest` (full core suite, no
  regressions)
- `pnpm --filter @librarian/mcp-server test:vitest` (catches any
  worker-side break from the curator surface change)

**Dependencies:** Task 1.1.

**Files likely touched:**
- `packages/core/src/curator-config.ts` (refactored)

**Scope:** S (1 file, well-bounded refactor).

#### Checkpoint after Phase 1

- [ ] All tests pass across the repo.
- [ ] `pnpm -r typecheck` green.
- [ ] The curator dashboard still renders the same config form (no
      visible drift) — eyeball at `/curator`.
- [ ] Commit as one PR titled `refactor(core): extract llm-connection
      helper, route curator through it`.

### Phase / Slice 2 — Classifier-config module

**Goal:** All classifier config logic lives in `@librarian/core` with
tests. No wiring yet.

#### Task 2.1: `core/classifier-config.ts` core types + read/write

**Description:** Implement `ClassifierConfig`,
`ClassifierConfigPatchSchema`, `readClassifierConfig`,
`writeClassifierConfig`, `resolveClassifierToken`,
`findLegacyClassifierEnvKeys`. Provider-mode + local-model knobs +
prompt version + the shared LLM connection block.

**Acceptance criteria:**
- `readClassifierConfig(store)` returns `ClassifierConfig` with
  `isOperational` computed as:
  - `enabled && llm.isComplete` when `providerMode === "remote"`
  - `enabled && local.modelId !== ""` when `providerMode === "local"`
- `writeClassifierConfig` validates: provider-mode enum, local.modelId
  required when patching local provider, prompt-version is either
  null or matches `/^v\d+$/`.
- Token stored encrypted; never returned by reads.
- `findLegacyClassifierEnvKeys(env)` returns the list of
  `LIBRARIAN_CLASSIFIER_*` keys present in the env, in declaration
  order.

**Verification:**
- `pnpm --filter @librarian/core test:vitest tests/classifier-config.test.ts`
- Coverage parity with `curator-config.test.ts` (defaults, validation,
  round-trip, secret never on the wire, mode-switching).

**Dependencies:** Task 1.1.

**Files likely touched:**
- `packages/core/src/classifier-config.ts` (new)
- `packages/core/src/index.ts` (re-exports)
- `packages/core/tests/classifier-config.test.ts` (new)

**Scope:** M (3 files; the tests are the bulk).

#### Task 2.2: `classifierConfigHash()` + token-rotation handling

**Description:** Stable hash function for drift detection. Hash input
includes every config field **plus the encrypted token blob** (fetched
via `store.getSetting(KEYS.llm.token)` — still encrypted at this
layer; the master key is never read).

```ts
export function classifierConfigHash(store: ConfigReader): string {
  const cfg = readClassifierConfig(store);
  const encryptedToken = store.getSetting(KEYS.llm.token) ?? "";
  const canonical = JSON.stringify({
    enabled: cfg.enabled,
    providerMode: cfg.providerMode,
    llm: {
      provider: cfg.llm.provider,
      endpoint: cfg.llm.endpoint,
      model: cfg.llm.model,
      timeoutMs: cfg.llm.timeoutMs,
    },
    local: cfg.local,
    promptVersion: cfg.promptVersion,
    tokenFingerprint: sha256(encryptedToken),
  });
  return sha256(canonical);
}
```

**Acceptance criteria:**
- Same config → same hash, run after run.
- Any field change → different hash.
- Token rotation (same key, new encrypted value) → different hash.
- Hash never includes plaintext token (verify with a test that
  inspects intermediate values).

**Verification:**
- `pnpm --filter @librarian/core test:vitest tests/classifier-config.test.ts`
  with the new hash tests.

**Dependencies:** Task 2.1.

**Files likely touched:**
- `packages/core/src/classifier-config.ts` (extended)
- `packages/core/tests/classifier-config.test.ts` (extended)

**Scope:** XS (1 file change + tests).

#### Checkpoint after Phase 2

- [ ] All tests pass.
- [ ] `classifier-config` + `llm-connection` exports show up in
      `@librarian/core` typed surface — verify via `pnpm --filter
      @librarian/mcp-server typecheck` (consumer-side import sanity).
- [ ] PR titled `feat(core): classifier-config module + hash`.

### Phase / Slice 3 — Boot/restart machinery + env-var retirement

**Goal:** mcp-server reads classifier config from the store, not env.
Worker registry, restart mutex, and self-test isolation all in place.

#### Task 3.1: Rewrite `classifier-startup.ts` to read from the store

**Description:** Replace env-driven boot with store-driven boot.
Introduce the registry: a module-scoped
`{ worker, classifier, lifecycle, configHash }` slot. `bootClassifierWorker`
reads `readClassifierConfig(store)`, builds the right provider, holds
the lifecycle handle externally (per A4), starts the worker, and
populates the registry.

**Acceptance criteria:**
- `bootClassifierWorker(input)` signature stays `(input) =>
  BootedClassifierWorker | null` for the caller in `index.ts`.
- No `process.env` references inside `classifier-startup.ts`.
- For provider=remote: builds `LlmClient` from the stored connection
  config (uses `resolveClassifierToken` for the token).
- For provider=local: constructs `createWorkerInferenceClient` first,
  retains the handle in the registry, passes `() => client` to
  `createClassifier`.
- `isClassifierRuntimeActive()` reflects registry state.
- `getRunningWorkerState()` (new export) returns
  `{ enabled: boolean, runningConfigHash: string | null }` — null when
  no worker is running, even if the store config is `enabled=true`.

**Verification:**
- `pnpm --filter @librarian/mcp-server test:vitest tests/classifier-startup.test.ts`
  — rewritten test cases:
  - boot returns null when stored config is disabled
  - boot returns null when remote config incomplete (no token)
  - boot returns a started worker when remote config complete
  - boot returns null when local config incomplete (no modelId)
  - boot returns a started worker when local config complete (with a
    test-injected `inferenceFor` to avoid loading a real model)
  - env-var notice emits on boot when any `LIBRARIAN_CLASSIFIER_*` is
    set, regardless of store state.

**Dependencies:** Task 2.1, Task 2.2.

**Files likely touched:**
- `packages/mcp-server/src/classifier-startup.ts` (rewritten)
- `packages/mcp-server/tests/classifier-startup.test.ts` (rewritten)

**Scope:** M (~200 lines of source + ~150 lines of tests).

#### Task 3.2: `restartClassifierWorker(store)` + mutex

**Description:** Implement the restart procedure described in the
**Shutdown ordering deep dive** section below. Single-flight via a
module-scoped Promise.

**Acceptance criteria:**
- Returns `{ outcome: "restarted" | "started" | "stopped" |
  "already_in_progress" | "failed", reason?: string,
  runningConfigHash: string | null }`.
- Concurrent calls return `"already_in_progress"` instead of starting
  a second restart.
- On error during step 7 / 8 (build new classifier or start new
  worker), the registry is left in a clean `null` state and the
  outcome is `"failed"` with `reason`.
- `worker.stop()` resolves before any new worker is constructed (no
  overlap window).
- Local-provider lifecycle is terminated between stop and rebuild.
- Hash is recomputed only from the **current store state** after the
  swap.

**Verification:**
- `pnpm --filter @librarian/mcp-server test:vitest tests/classifier-restart.test.ts`
  (new file). Cases:
  - restart with disabled → enabled config: `outcome=started`
  - restart with enabled → disabled config: `outcome=stopped`
  - restart with config change while enabled: `outcome=restarted`
  - concurrent restart: second call returns
    `already_in_progress`
  - boot failure (e.g. invalid local modelId at build time): registry
    is null, outcome=failed, prior worker is also gone
  - local provider terminate is called between stop and new boot

**Dependencies:** Task 3.1.

**Files likely touched:**
- `packages/mcp-server/src/classifier-startup.ts` (extended)
- `packages/mcp-server/tests/classifier-restart.test.ts` (new)

**Scope:** M (1 source file + 1 test file).

#### Task 3.3: `runClassifierSelfTest(store)` in a transient instance

**Description:** Build a fresh, ephemeral classifier (no registry
slot, separate lifecycle), invoke `runSelfTest(classifier)` from
`@librarian/classifier`, and tear down. Return the verdict, latency,
fallback reason, and the configured provider mode.

**Acceptance criteria:**
- Self-test does NOT touch the running worker's classifier instance.
- For local provider, the transient lifecycle handle is terminated in
  a `try/finally` so a thrown error doesn't leak a worker thread.
- Returns `{ outcome: "ok" | "fallback" | "error",
  verdict?, latencyMs, fallbackReason?, error? }`.
- Operates without a running worker (the test should work even when
  `getRunningWorkerState()` returns null).

**Verification:**
- `pnpm --filter @librarian/mcp-server test:vitest tests/classifier-self-test.test.ts`
- Cases: ok path (remote with stub client), fallback path,
  provider-unavailable error, missing-config error.

**Dependencies:** Task 3.1.

**Files likely touched:**
- `packages/mcp-server/src/classifier-startup.ts` (extended)
- `packages/mcp-server/tests/classifier-self-test.test.ts` (new)

**Scope:** S (1 source file + 1 test file).

#### Task 3.4: Wire env-var retirement notice

**Description:** Inside `bootClassifierWorker`, before reading the
store, call `findLegacyClassifierEnvKeys(input.env ?? process.env)`.
If non-empty, log a structured `classifier_env_retired` entry naming
the keys present.

**Acceptance criteria:**
- Notice fires once per boot when any retired env is set.
- Notice does not change behaviour — boot proceeds from the store
  regardless.
- The notice text reads: `"Classifier env vars are retired in this
  release; configure via the /classifier dashboard cockpit. Ignored
  keys: <comma-separated>."`

**Verification:**
- Covered by the env-retired test case in Task 3.1's rewritten test
  suite.

**Dependencies:** Task 3.1, Task 2.1.

**Files likely touched:** Already covered in Task 3.1's surface.

**Scope:** XS (extension to an existing change).

#### Checkpoint after Phase 3

- [ ] All tests pass.
- [ ] `grep -r "LIBRARIAN_CLASSIFIER" packages apps docs scripts docker
      .env.example` returns only the CHANGELOG retroactive note + the
      single boot-notice string literal + the new
      `findLegacyClassifierEnvKeys` constant.
- [ ] `node scripts/check-schema-version.mjs` OK.
- [ ] PR titled `feat(mcp-server): store-driven classifier boot +
      restart + self-test; retire LIBRARIAN_CLASSIFIER_* env vars`.

### Phase / Slice 4 — tRPC surface

**Goal:** Admin can read and write classifier config from the
dashboard via tRPC, observe drift, restart, and self-test.

#### Task 4.1: `classifier-config` tRPC router

**Description:** Five admin-gated procedures: `config`, `setConfig`,
`workerState`, `restartWorker`, `selfTest`. Mounted on `appRouter` as
`classifierConfig`.

**Acceptance criteria:**
- `config`: returns `readClassifierConfig(ctx.store)`.
- `setConfig`: validates via `ClassifierConfigPatchSchema`, calls
  `writeClassifierConfig`, returns the fresh config.
- `workerState`: returns `{ runningConfigHash: string | null,
  storedConfigHash: string, hasDrift: boolean }`.
- `restartWorker`: calls `restartClassifierWorker(ctx.store)` and
  returns its outcome.
- `selfTest`: calls `runClassifierSelfTest(ctx.store)` and returns the
  result.
- All procedures admin-gated (use existing `adminProcedure`).
- Token never appears on the wire (asserted by a test that snapshots
  `config` and `setConfig` outputs against a fixture).

**Verification:**
- `pnpm --filter @librarian/mcp-server test:vitest tests/trpc/classifier-config.test.ts`
- Auth gating: non-admin call returns 401/UNAUTHORIZED.

**Dependencies:** Task 3.2, Task 3.3.

**Files likely touched:**
- `packages/mcp-server/src/trpc/classifier-config.ts` (new)
- `packages/mcp-server/src/trpc/router.ts` (mount)
- `packages/mcp-server/tests/trpc/classifier-config.test.ts` (new)

**Scope:** M (3 files; the test file carries most of the lines).

#### Checkpoint after Phase 4

- [ ] All tests pass.
- [ ] `pnpm --filter @librarian/dashboard typecheck` green (verifies
      the inferred `AppRouter` reaches the dashboard cleanly — the
      sessions-rethink PR 7 TS2742 trap is the relevant precedent).
- [ ] PR titled `feat(mcp-server): tRPC classifier-config surface`.

### Phase / Slice 5 — Dashboard cockpit

**Goal:** Admin can do the whole job from the dashboard.

#### Task 5.1: `/classifier` page scaffolding + summary

**Description:** New route at `apps/dashboard/app/classifier/page.tsx`
mirroring `/curator`. Renders a `ClassifierConfigSummary` component
(read-only state) and embeds the config form below. Server-side data
fetch via `trpc.classifierConfig.config` and `workerState`.

**Acceptance criteria:**
- Page mounts, server-renders the current config.
- Summary shows: enabled state, provider mode, `hasToken`,
  `isOperational`, and a drift banner when `hasDrift === true`.
- The drift banner is yellow and shows a "Restart classifier worker"
  button (wired in Task 5.3).
- The summary mirrors `components/curator/config-summary.tsx`
  visually.

**Verification:**
- `pnpm --filter @librarian/dashboard test`
- New component test:
  `apps/dashboard/tests/components/classifier/config-summary.test.tsx`.

**Dependencies:** Task 4.1.

**Files likely touched:**
- `apps/dashboard/app/classifier/page.tsx` (new)
- `apps/dashboard/components/classifier/config-summary.tsx` (new)
- `apps/dashboard/tests/components/classifier/config-summary.test.tsx`
  (new)

**Scope:** M (3 files).

#### Task 5.2: Config form (remote + local modes)

**Description:** `components/classifier/config-form.tsx`. Provider-mode
radio toggles two field groups. Local mode renders a `<select>` from
`CATALOG` plus a collapsible custom-id input and a `quant` input.
Token field is masked (`type=password`) and never pre-filled; empty
submission preserves the existing token.

**Acceptance criteria:**
- Form renders for both provider modes.
- Switching modes preserves cross-mode state in component state
  (in case the admin flips back).
- Submit calls `trpc.classifierConfig.setConfig` with the patch.
- After successful save, the page refreshes (or the form's parent
  re-fetches) `workerState` so the drift banner appears.
- Validation errors from `setConfig` surface inline.

**Verification:**
- `pnpm --filter @librarian/dashboard test`
- Component test:
  `apps/dashboard/tests/components/classifier/config-form.test.tsx`
  (renders for both modes, switching modes, dirty state, save calls
  the action).

**Dependencies:** Task 5.1.

**Files likely touched:**
- `apps/dashboard/components/classifier/config-form.tsx` (new)
- `apps/dashboard/app/classifier/actions.ts` (server actions, new)
- `apps/dashboard/tests/components/classifier/config-form.test.tsx`
  (new)

**Scope:** L (3 files but the form file is substantial — ~250 lines).

#### Task 5.3: Restart-worker + self-test buttons

**Description:** Two small components.
`components/classifier/restart-worker-button.tsx` posts to
`trpc.classifierConfig.restartWorker` and shows a toast based on the
outcome. `components/classifier/self-test-button.tsx` posts to
`trpc.classifierConfig.selfTest` and renders a result panel
(verdict / latency / fallback reason).

**Acceptance criteria:**
- Buttons are disabled while the mutation is in flight.
- Restart shows the outcome (`Restarted`, `Started`, `Stopped`,
  `Already in progress`, `Failed: <reason>`).
- Self-test panel renders the verdict booleans, latency in ms, and
  the fallback reason (if any).
- Both buttons are admin-gated by the same path as the rest of the
  page.

**Verification:**
- `pnpm --filter @librarian/dashboard test`
- Component tests for both.

**Dependencies:** Task 5.1.

**Files likely touched:**
- `apps/dashboard/components/classifier/restart-worker-button.tsx`
  (new)
- `apps/dashboard/components/classifier/self-test-button.tsx` (new)
- `apps/dashboard/tests/components/classifier/restart-worker-button.test.tsx`
  (new)
- `apps/dashboard/tests/components/classifier/self-test-button.test.tsx`
  (new)

**Scope:** M (4 files but each is small).

#### Task 5.4: Nav + palette wiring

**Description:** Add `/classifier` to `components/site-nav.tsx` (after
`/curator`), `components/keyboard-host.tsx` (`G C` shortcut, palette
entry).

**Acceptance criteria:**
- Site-nav lists "Classifier" between "Curator" and "Backups".
- Cmd-K palette includes "Go to Classifier".
- `G C` keybinding navigates to `/classifier`.
- Existing site-nav test extended to include the new entry.

**Verification:**
- `pnpm --filter @librarian/dashboard test:vitest tests/components/site-nav.test.tsx`

**Dependencies:** Task 5.1.

**Files likely touched:**
- `apps/dashboard/components/site-nav.tsx`
- `apps/dashboard/components/keyboard-host.tsx`
- `apps/dashboard/tests/components/site-nav.test.tsx`

**Scope:** S (3 files, small edits each).

#### Task 5.5: E2E spec

**Description:** Playwright `apps/dashboard/e2e/classifier-cockpit.spec.ts`.
Happy path only.

**Acceptance criteria:**
- Test fixture seeds an admin user.
- Test navigates to `/classifier`, fills the remote config form
  (`provider`, `endpoint`, `model`, `token`, `timeoutMs`), saves,
  observes "Restart classifier worker" banner, clicks restart, runs
  self-test, sees the result panel.
- The MCP backend used by the test stubs the LLM (existing fixture
  pattern from `e2e/fixtures.ts`).

**Verification:**
- `pnpm --filter @librarian/dashboard test:e2e` (CI's Playwright job).

**Dependencies:** Tasks 5.1–5.4.

**Files likely touched:**
- `apps/dashboard/e2e/classifier-cockpit.spec.ts` (new)
- `apps/dashboard/e2e/fixtures.ts` (extend with a `setClassifierConfig`
  helper, if it doesn't already exist)

**Scope:** M (1–2 files).

#### Checkpoint after Phase 5

- [ ] All tests pass, including Playwright e2e.
- [ ] Manual eyeball at `/classifier`: configure remote provider in
      a dev instance, restart worker, run self-test.
- [ ] `node scripts/healthcheck.js` OK.
- [ ] CHANGELOG `[Unreleased]` updated under `### Added` (cockpit) and
      `### Removed` (env vars).
- [ ] PR titled `feat(dashboard): /classifier cockpit + retire
      LIBRARIAN_CLASSIFIER_* env contract`.

## Shutdown ordering — deep dive

The spec called this out as ambiguous. Spelling it out:

### Pre-conditions

- `worker.stop(): Promise<void>` is already correctly designed to wait
  for the in-flight `tick()` to finish (see `classifier-worker.ts`
  lines 241–260). The current implementation has no built-in timeout —
  it waits forever.
- Local provider's `LocalInferenceClientWithLifecycle.terminate():
  Promise<void>` is idempotent (see `local-worker-host.ts` line 164,
  `if (terminated) return`).
- Remote provider has no separate lifecycle handle.

### The `restartClassifierWorker(store)` procedure

```text
1. Acquire the mutex
   if (restartInFlight) return await restartInFlight;
   const settle = createDeferred<RestartOutcome>();
   restartInFlight = settle.promise;

2. Snapshot the current registry slot
   const prior = currentlyRunning;  // may be null

3. Stop the prior worker (if any)
   if (prior) {
     log("classifier-restart.draining");
     const drainStart = now();
     await prior.worker.stop();              // waits for in-flight tick()
     const drainMs = now() - drainStart;
     if (drainMs > 30_000) log("classifier-restart.drain_slow", { drainMs });
   }

4. Terminate the prior lifecycle (if any)
   if (prior?.lifecycle) {
     await prior.lifecycle.terminate();      // idempotent
   }

5. Clear the registry slot before booting again
   currentlyRunning = null;
   runtimeActive = false;

6. Read the current stored config
   const cfg = readClassifierConfig(store);
   const newHash = classifierConfigHash(store);

7. If disabled / incomplete, leave the registry empty
   if (!cfg.isOperational) {
     resolve({ outcome: prior ? "stopped" : "stopped",
               runningConfigHash: null });
     return;
   }

8. Build the new classifier
   try {
     const built = await buildBootedWorker(cfg, input);   // throws on failure
     built.start();
     currentlyRunning = built;
     runtimeActive = true;
     resolve({
       outcome: prior ? "restarted" : "started",
       runningConfigHash: newHash,
     });
   } catch (err) {
     // Registry stays null — prior worker is already stopped + lifecycle terminated.
     log("classifier-restart.boot_failed", { error: msg(err) });
     resolve({ outcome: "failed", reason: msg(err), runningConfigHash: null });
   }

9. Release the mutex
   finally { restartInFlight = null; }
```

### What can race?

- **`isClassifierRuntimeActive()` reads** happen on the
  `remember` MCP tool handler thread. Between steps 5 and 8 the flag
  is `false`, so concurrent writes during a restart land at
  conservative defaults (which is the *correct* behaviour — there's
  no live classifier). This is a feature, not a bug.

- **`getRunningWorkerState()` reads** during a restart return the
  intermediate state. The dashboard cockpit polls this every 5
  seconds; a single transient null reading during a restart is fine
  (the next poll returns the post-restart state).

- **Concurrent `setConfig` calls during a restart** are not blocked —
  they update the store. The post-restart hash reflects the latest
  store state. If the operator saves twice in quick succession and
  then restarts once, only one restart happens, and the worker boots
  with the most recent config. Drift detection will then show "no
  drift" because the running hash matches the stored hash.

- **Concurrent `restartWorker` calls** are coalesced via the mutex.
  Both callers receive the same `RestartOutcome`. The second caller
  doesn't trigger a second restart; the second `await restartInFlight`
  returns the first call's resolved value.

### What if shutdown hangs?

The current `worker.stop()` design has no timeout — a wedged provider
could hold the restart indefinitely. We log a `drain_slow` event when
drain exceeds 30 seconds but do not force-kill. If this becomes a real
problem, a future PR can:

- Add an `AbortController` plumbed through to the in-flight classify
  call (the remote provider's `LlmClient` already supports it; the
  local-worker-host's classify is harder to abort cleanly).
- Expose a `forceTerminate()` outcome from `restartWorker` that bypasses
  drain and just calls `lifecycle.terminate()` immediately. Document
  the data-loss risk (the in-flight memory's classify result is lost
  and the row stays in `pending`).

Both are out of scope for this plan.

### Lifecycle invariant

After `restartClassifierWorker` resolves, exactly one of these holds:

| `currentlyRunning` | `isClassifierRuntimeActive()` | Outcome |
|---|---|---|
| not null | `true` | `restarted` or `started` |
| null | `false` | `stopped` or `failed` |

There is no observable intermediate state once `restartClassifierWorker`
has resolved — the resolution itself is the commit point.

## Other ambiguities resolved

### CHANGELOG retroactive note allowance

The spec's success criterion includes
`grep -r "LIBRARIAN_CLASSIFIER" ...` returning only the retroactive
CHANGELOG entry + the boot-notice constant + the
`findLegacyClassifierEnvKeys` array. To make this enforceable in CI,
we add a guard script:
`scripts/check-classifier-env-retirement.mjs` — runs the grep, allows
a small explicit allowlist of file paths
(`CHANGELOG.md`, `packages/core/src/classifier-config.ts`,
`packages/mcp-server/src/classifier-startup.ts`,
`docs/specs/done/classifier-implementation-spec.md`), and fails CI on
any other occurrence. Add to the CI workflow alongside the existing
guard steps.

### Boot-notice format

Structured log entry, single emission per boot:

```json
{
  "event": "classifier_env_retired",
  "level": "warn",
  "keys": ["LIBRARIAN_CLASSIFIER_ENABLED", "LIBRARIAN_CLASSIFIER_PROVIDER"],
  "hint": "Configure via the /classifier dashboard cockpit."
}
```

Emitted via the existing `input.log` sidecar (the same path
`bootClassifierWorker` already uses).

### Local-model catalog source

The dashboard imports `CATALOG`, `DEFAULT_MODEL_ID`, and `catalogEntry`
from `@librarian/classifier` (already exported). The catalog list is
small (a handful of entries) and stable at build time — no runtime
fetch.

### Prompt-version selection

The classifier already supports `promptVersion` in `ProviderConfig`.
We expose it as an optional text input (`null` ↔ "use the classifier
package default"). Validation: must match `/^v\d+$/` when set.

### Self-test concurrency with the running worker

Both can run simultaneously without locking — the running worker uses
`currentlyRunning.classifier`; self-test uses its own transient
classifier instance built fresh from the store config. The only
shared resource is the LLM provider's endpoint, which is the
operator's responsibility (rate-limit, etc.).

For local provider specifically, self-test loads a **second** Node
Worker thread for the duration of the test, then terminates it.
Memory pressure is the operator's call; the cockpit shows a tooltip
on the button explaining the cost for local mode.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Curator refactor breaks production curator | High | `curator-config.test.ts` is untouched and is the canary. If Phase 1 tests regress, revert Task 1.2 and ship the helper as classifier-only (Task 1.1) — leaves curator on its own duplicate path, file a follow-up. |
| TS2742 inferred-type-portability fires on `appRouter` after adding `classifierConfig` to the router | Medium | Watched for via the existing dashboard typecheck in Phase 4 checkpoint. Precedent: sessions-rethink PR 7 hit exactly this and fixed it via local-shape interfaces in `memories.ts`. Apply the same pattern preemptively if the boundary needs casting. |
| Local provider restart leaks worker threads | Medium | `lifecycle.terminate()` is idempotent; the restart procedure calls it unconditionally between stop and rebuild. Test verifies a `terminate()` spy is called exactly once per restart. |
| Self-test on local provider exhausts host memory | Low | Cockpit tooltip warns; admin opts in explicitly. Self-test classifier is torn down in `finally`. |
| Token rotation drift detection misses encrypted-blob change due to caching | Low | The hash reads `getSetting()` fresh each call; the SQLite read is cheap. No caching layer. Tests verify rotation triggers a hash change. |
| Concurrent admins clobber each other's `setConfig` writes | Low | Last-write-wins; matches curator's posture. A future "lock the config form while another admin is editing" feature is out of scope. |
| Boot fails after env vars retired but before admin configures dashboard | Medium | Designed-in: `bootClassifierWorker` returns `null` and mcp-server continues to boot without the classifier. Writes go through the legacy bridge (pre-4d behaviour). Boot notice tells the admin where to go. Documented in CHANGELOG. |

## Parallelization opportunities

- Phase 1 (Tasks 1.1 + 1.2) are sequential.
- Phase 2 (Tasks 2.1 + 2.2) are sequential (2.2 builds on 2.1's
  module).
- Phase 3 (Tasks 3.1–3.4): 3.1 first; 3.2, 3.3, 3.4 can land in
  parallel branches once 3.1 merges (each touches different parts
  of the same file plus its own test file).
- Phase 4 (Task 4.1) is sequential after Phase 3.
- Phase 5 (Tasks 5.1–5.5): 5.1 first; 5.2 + 5.3 + 5.4 can be parallel
  PRs once 5.1 merges; 5.5 last.

In practice this is a sequential single-author project — calling out
the parallelism so a multi-agent sweep (or a future re-spin) can pick
it up.

## Open questions

(Reserved for any new ambiguities discovered during implementation.
The spec's original four open questions were resolved before the
spec was authored.)

1. *(none yet)*

## Reviewer checklist

- [ ] Plan covers all six core areas the spec promised.
- [ ] Shutdown ordering is explicit enough to implement without
      further clarification.
- [ ] Each task has acceptance criteria + verification + dependencies
      + file list.
- [ ] No task exceeds the M-or-smaller sizing.
- [ ] Risks and mitigations match the design decisions.
- [ ] Checkpoints land between phases, not inside them.
- [ ] The CHANGELOG / CI-guard story is concrete.

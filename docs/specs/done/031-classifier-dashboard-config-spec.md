# Spec: classifier dashboard config

> **Partially superseded by [`032-remove-local-classifier-spec.md`](./032-remove-local-classifier-spec.md).**
> The provider-mode toggle and the local-model cockpit fields described below
> were removed; the cockpit configures a remote OpenAI-compatible endpoint only.
> Kept for provenance — read 032 for current behaviour.

Move the classifier LLM config off environment variables and into the
existing admin settings store, mirroring the curator's cockpit. Share the
LLM-connection block with the curator so both pieces use one tested
helper, and retire the `LIBRARIAN_CLASSIFIER_*` env vars.

## Objective

**What:** Replace `bootClassifierWorker`'s env-driven config (`LIBRARIAN_CLASSIFIER_ENABLED`,
`_PROVIDER`, `_REMOTE_ENDPOINT`, `_REMOTE_TOKEN`, `_REMOTE_MODEL`, `_LOCAL_MODEL`,
`_LOCAL_QUANT`) with admin-settings-store persistence read from a new
`/classifier` dashboard cockpit. The curator's existing config plumbing
(`packages/core/src/curator-config.ts` + `packages/mcp-server/src/trpc/curator.ts`
+ `apps/dashboard/components/curator/*`) is the reference implementation; the
classifier mirror reuses the LLM-connection shape, secret-token plumbing, and
form layout, and adds provider-mode (`remote` | `local`) plus a local-model
catalog picker.

**Why:** The classifier-startup file has been carrying a `// admin-settings persistence
is a 4d.2 follow-up` TODO since 4d landed. Env vars are operator-hostile
(can't change without a restart, can't surface "is it on?" in the dashboard,
secrets travel through the process environment). The curator already solved
this; the gap is asymmetric. Closing it puts both LLM-using subsystems on the
same operator surface.

**Who:** The operator/owner running a Librarian instance — they configure the
classifier from the dashboard the same way they configure the curator today.
No agent-facing API change.

**Success looks like:**

- `LIBRARIAN_CLASSIFIER_*` env vars are gone from the codebase (source, tests,
  docs).
- `/classifier` dashboard route exists, mirrors `/curator` ergonomically.
- An admin can configure provider/endpoint/model/token (or local model + quant),
  save, see the new state reflected in a "Restart classifier worker" warning,
  click that button, and observe the worker picking up the new config.
- A "Test classifier" button runs `runSelfTest` from `@librarian/classifier`
  against the configured provider and reports verdict + latency + fallback
  reason.
- The shared `llm-connection` helper is the only place LLM-connection settings
  read/write logic lives. Curator's existing tests pass against the refactored
  curator-config; new classifier-config tests cover the same shape.

## Tech Stack

- `@librarian/core` — TypeScript, Zod validation, settings/secret-store
  (existing). Schema-bumped projection tables not affected.
- `@librarian/classifier` — existing provider abstractions
  (`createClassifier`, `ProviderConfig`, `runSelfTest`,
  `CATALOG`, `DEFAULT_MODEL_ID`).
- `@librarian/mcp-server` — boot wiring + a new tRPC `classifierConfig`
  router (admin-gated).
- `@librarian/dashboard` (apps/dashboard) — Next.js admin cockpit;
  Tailwind; existing UI primitives in `components/ui-v2`.

No new runtime deps.

## Commands

```sh
# At the repo root (pnpm monorepo)
pnpm install
pnpm -r build                       # builds all workspaces
pnpm -r typecheck                   # full repo typecheck
pnpm -r test                        # all package tests (vitest)
pnpm exec prettier --check .        # format gate
pnpm exec eslint . --max-warnings 0 # lint gate

# Targeted:
pnpm --filter @librarian/core test:vitest
pnpm --filter @librarian/mcp-server test:vitest
pnpm --filter @librarian/dashboard test

# Schema fingerprint guard (no schema changes expected; run anyway):
node scripts/check-schema-version.mjs

# Local dev:
pnpm --filter @librarian/mcp-server dev    # server on 3838
pnpm --filter @librarian/dashboard dev     # dashboard on 3000
```

## Project Structure

```
packages/core/src/
├── llm-connection.ts              # NEW — shared LLM-connection helper
├── classifier-config.ts           # NEW — read/write/resolveToken for classifier
└── curator-config.ts              # REFACTORED — uses llm-connection helper

packages/core/tests/
├── llm-connection.test.ts         # NEW
├── classifier-config.test.ts      # NEW
└── curator-config.test.ts         # existing, must keep passing

packages/mcp-server/src/
├── classifier-startup.ts          # REWRITTEN — reads store, not env
├── trpc/
│   ├── classifier-config.ts       # NEW — admin tRPC router
│   ├── curator.ts                 # existing, unchanged surface
│   └── router.ts                  # add `classifierConfig` to appRouter

apps/dashboard/
├── app/classifier/
│   ├── page.tsx                   # NEW — cockpit page, mirrors /curator
│   └── actions.ts                 # NEW — server actions
├── components/classifier/
│   ├── config-form.tsx            # NEW — mirrors curator config-form
│   ├── config-summary.tsx         # NEW
│   ├── restart-worker-button.tsx  # NEW — replaces curator run-now button
│   └── self-test-button.tsx       # NEW
├── components/site-nav.tsx        # add "Classifier" tab
└── components/keyboard-host.tsx   # add /classifier to palette + shortcut

docs/specs/done/
└── 031-classifier-dashboard-config-spec.md   # this file, archived on completion
```

## Code Style

The shared LLM-connection helper looks like this (the load-bearing piece —
both configs will route through it):

```ts
// packages/core/src/llm-connection.ts
import { z } from "zod";
import type { SettingMeta } from "./store/settings-store.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;

export interface LlmConnection {
  provider: string;
  endpoint: string;
  model: string;
  timeoutMs: number;
}

export interface LlmConnectionPatch {
  provider?: string;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
}

export const LlmConnectionPatchSchema = z.strictObject({
  provider: z.string().optional(),
  endpoint: z.string().optional(),
  model: z.string().optional(),
  timeoutMs: z.number().optional(),
});

interface ConfigReader {
  getSetting: (key: string) => string | null;
  listSettings: () => SettingMeta[];
}

interface ConfigWriter {
  setSetting: (key: string, value: string, options?: { secret?: boolean }) => void;
  deleteSetting: (key: string) => void;
}

// Each consumer passes its own key prefix (e.g. "curator.llm" or "classifier.llm").
// All settings keys live under <prefix>.<field>.
export interface LlmConnectionKeys {
  provider: string;
  endpoint: string;
  model: string;
  timeoutMs: string;
  token: string;
}

export function llmConnectionKeys(prefix: string): LlmConnectionKeys {
  return {
    provider: `${prefix}.provider`,
    endpoint: `${prefix}.endpoint`,
    model: `${prefix}.model`,
    timeoutMs: `${prefix}.timeout_ms`,
    token: `${prefix}.token`,
  };
}

export function readLlmConnection(
  store: ConfigReader,
  keys: LlmConnectionKeys,
): LlmConnection & { hasToken: boolean; isComplete: boolean } {
  const provider = store.getSetting(keys.provider) ?? "";
  const endpoint = store.getSetting(keys.endpoint) ?? "";
  const model = store.getSetting(keys.model) ?? "";
  const hasToken = store.listSettings().some((s) => s.key === keys.token);
  const timeoutMs = parseTimeoutMs(store.getSetting(keys.timeoutMs));
  return {
    provider,
    endpoint,
    model,
    timeoutMs,
    hasToken,
    isComplete: Boolean(provider && endpoint && model && hasToken),
  };
}

export function writeLlmConnection(
  store: ConfigWriter,
  keys: LlmConnectionKeys,
  patch: LlmConnectionPatch & { token?: string },
): void {
  if (patch.timeoutMs !== undefined) {
    const t = patch.timeoutMs;
    if (!Number.isInteger(t) || t < MIN_TIMEOUT_MS || t > MAX_TIMEOUT_MS) {
      throw new Error(
        `timeout_ms must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`,
      );
    }
  }
  if (patch.provider !== undefined) store.setSetting(keys.provider, patch.provider);
  if (patch.endpoint !== undefined) store.setSetting(keys.endpoint, patch.endpoint);
  if (patch.model !== undefined) store.setSetting(keys.model, patch.model);
  if (patch.timeoutMs !== undefined) store.setSetting(keys.timeoutMs, String(patch.timeoutMs));
  if (patch.token !== undefined) {
    if (patch.token === "") store.deleteSetting(keys.token);
    else store.setSetting(keys.token, patch.token, { secret: true });
  }
}

export function resolveLlmToken(
  store: { getSetting: (key: string) => string | null },
  keys: LlmConnectionKeys,
): string | null {
  return store.getSetting(keys.token);
}

function parseTimeoutMs(raw: string | null): number {
  const n = Number(raw);
  return raw !== null && Number.isFinite(n) ? n : DEFAULT_TIMEOUT_MS;
}
```

The classifier-config module composes the shared helper with classifier-specific
fields:

```ts
// packages/core/src/classifier-config.ts (excerpt)
import {
  LlmConnectionPatchSchema,
  llmConnectionKeys,
  readLlmConnection,
  writeLlmConnection,
  resolveLlmToken,
  type LlmConnectionPatch,
} from "./llm-connection.js";

const KEYS = {
  enabled: "classifier.enabled",
  providerMode: "classifier.provider_mode", // "remote" | "local"
  localModelId: "classifier.local.model_id",
  localQuant: "classifier.local.quant",
  promptVersion: "classifier.prompt_version",
  llm: llmConnectionKeys("classifier.llm"), // provider/endpoint/model/timeout/token
} as const;

export type ProviderMode = "remote" | "local";

export interface ClassifierConfig {
  enabled: boolean;
  providerMode: ProviderMode;
  llm: ReturnType<typeof readLlmConnection>;
  local: { modelId: string; quant: string | null };
  promptVersion: string | null;
  isOperational: boolean; // enabled && (remote ? llm.isComplete : local.modelId !== "")
}

export const ClassifierConfigPatchSchema = z.strictObject({
  enabled: z.boolean().optional(),
  providerMode: z.enum(["remote", "local"]).optional(),
  llm: LlmConnectionPatchSchema.optional(),
  token: z.string().optional(),
  local: z
    .strictObject({
      modelId: z.string().optional(),
      quant: z.string().nullable().optional(),
    })
    .optional(),
  promptVersion: z.string().nullable().optional(),
});

// readClassifierConfig / writeClassifierConfig / resolveClassifierToken below…
```

The tRPC router mirrors the curator's:

```ts
// packages/mcp-server/src/trpc/classifier-config.ts
export const classifierConfigRouter = router({
  config: adminProcedure.query(({ ctx }) => readClassifierConfig(ctx.store)),
  setConfig: adminProcedure.input(ClassifierConfigPatchSchema).mutation(({ ctx, input }) => {
    writeClassifierConfig(ctx.store, input as ClassifierConfigPatch);
    return readClassifierConfig(ctx.store);
  }),
  // Restart-required signal (see "Restart semantics" below).
  workerState: adminProcedure.query(({ ctx }) => ({
    runningConfigHash: classifierRunningHash(),
    storedConfigHash: classifierStoredHash(ctx.store),
  })),
  restartWorker: adminProcedure.mutation(async ({ ctx }) => restartClassifierWorker(ctx.store)),
  selfTest: adminProcedure.mutation(async ({ ctx }) => runClassifierSelfTest(ctx.store)),
});
```

Naming follows the existing curator pattern: `readXConfig` / `writeXConfig` /
`XConfigPatchSchema`. Tests live alongside source as `tests/<name>.test.ts` in
the same package.

## Testing Strategy

**Framework:** vitest for all unit/integration tests in `packages/*` and
`apps/dashboard`. Playwright e2e tests in `apps/dashboard/e2e` cover the
dashboard cockpit user flow.

**Coverage requirements:**

- **`packages/core/tests/llm-connection.test.ts`** — round-trip read/write,
  presence/completeness flags, token never returned by reads, validation
  bounds on `timeoutMs`, key-prefix isolation (writes under
  `curator.llm` don't leak into `classifier.llm`).
- **`packages/core/tests/classifier-config.test.ts`** — mirrors the existing
  `curator-config.test.ts` shape: defaults, provider-mode switching,
  validation (provider mode enum, modelId required when local), `isOperational`
  truth table (remote: needs full LLM connection; local: needs `modelId`),
  legacy env-key detection (parallels `findLegacyScheduleKeys` for the
  classifier env vars).
- **`packages/core/tests/curator-config.test.ts`** — existing 10 tests pass
  unmodified after the curator refactor (behavioural parity is the bar).
- **`packages/mcp-server/tests/classifier-startup.test.ts`** — rewritten:
  `bootClassifierWorker` reads from store, not env. Cases: disabled,
  remote incomplete, remote complete, local incomplete, local complete,
  worker restart picks up new config.
- **`packages/mcp-server/tests/trpc/classifier-config.test.ts`** — NEW.
  `config` / `setConfig` / `workerState` / `restartWorker` / `selfTest`
  procedures, including admin-gating, token never on the wire, and
  drift-detection logic.
- **`apps/dashboard/tests/components/classifier/config-form.test.tsx`** — NEW.
  Form renders for both provider modes, local-mode shows catalog picker +
  custom-id collapsible, dirty-form state, save action wiring.
- **`apps/dashboard/e2e/classifier-cockpit.spec.ts`** — NEW. Happy path:
  open `/classifier`, configure remote provider, save, observe "restart
  required" banner, click restart, run self-test, see result.

**Levels:**

- Unit: every config helper, validation rule, hash function.
- Integration: tRPC procedures against a real `LibrarianStore` (matches
  curator router test pattern).
- E2E: one happy-path Playwright spec to pin the cockpit UX.

## Boundaries

**Always do:**
- Run `pnpm -r typecheck && pnpm -r test` before each commit.
- Keep curator behavioural tests green throughout the refactor (it's the
  canary for the shared helper extraction).
- Treat the token as a secret end-to-end: never returned by `readXConfig`,
  never logged, never surfaced in errors, encrypted at rest.
- Update CHANGELOG `[Unreleased]` in the same PR that ships each milestone.

**Ask first:**
- Any new settings key not listed in this spec.
- Adding a new dependency to `apps/dashboard` or `@librarian/classifier`.
- Changing the `Classifier` / `ProviderConfig` shape exposed by
  `@librarian/classifier` (it's consumed by tests and the worker).
- Adding a new tRPC procedure beyond the five listed.

**Never do:**
- Persist the LLM token in plaintext.
- Leave a `LIBRARIAN_CLASSIFIER_*` reference behind (source, tests, docs,
  `.env.example`, docker-compose, CHANGELOG retroactive notes excepted).
- Implement live-swap config reloading (the spec is restart-required).
- Bypass `writeClassifierConfig`'s validation in tests by writing raw
  settings rows.

## Restart semantics (design call-out)

The classifier worker is started once at boot and processes the `memory.pending`
queue continuously. Unlike the curator scheduler (which reads config every tick),
the worker holds a live `Classifier` instance built from a snapshot of the
config at boot time. To pick up a change:

1. Admin saves a new config via `setConfig`.
2. `workerState` query returns `{ runningConfigHash, storedConfigHash }`.
   When they diverge, the dashboard renders a yellow banner: "Config has
   changed since the worker started. Restart to apply."
3. Admin clicks "Restart classifier worker" → `restartWorker` mutation
   calls `worker.stop()` then `bootClassifierWorker({ store, … })` again
   from the same process.
4. The new worker reads the current config from the store and starts.

Hash function: deterministic SHA-256 of a stable JSON serialization of the
config (excluding the token plaintext — use `hasToken` boolean instead, so
rotating the token still triggers a restart prompt). Implementation in
`classifier-config.ts` as `classifierConfigHash(config)`.

## Local-model picker

The form's "Provider mode" radio switches between two field groups:

- **Remote** (default): the standard LLM-connection form (provider,
  endpoint, model, token, timeoutMs).
- **Local**: a `<select>` populated from `CATALOG` (imported from
  `@librarian/classifier`) listing each entry's `displayName` and
  `modelId`. Below the select, a collapsible "Use a custom model
  identifier" `<details>` exposes a plain text input for an HF id not
  in the catalog. An optional `quant` text input (e.g. "Q4_K_M") sits
  alongside.

The catalog list is rendered at build time (no runtime fetch); the
dashboard imports it via the existing `@librarian/classifier`
workspace package.

## Migration — hard break

- The next release retires every `LIBRARIAN_CLASSIFIER_*` env var
  without a fallback. The classifier-startup test that asserts env-vars
  produced the right `ProviderConfig` becomes a test asserting store
  settings do.
- CHANGELOG entry under `### Removed`: name every retired env var,
  point operators at `/classifier` in the dashboard.
- One-line boot notice if any `LIBRARIAN_CLASSIFIER_*` env var is set
  after the upgrade: "Classifier env vars are retired in vX.Y.Z;
  configure via the /classifier dashboard cockpit." (Operator-friendly
  diagnostic, no behaviour.)

## Success Criteria (testable)

- [ ] `grep -r "LIBRARIAN_CLASSIFIER" /Users/jim/code/the-librarian/{packages,apps,docs,scripts,docker,.env.example}` returns
  only the retroactive CHANGELOG entry + the boot-notice string.
- [ ] `pnpm --filter @librarian/core test:vitest tests/curator-config.test.ts`
  passes unmodified.
- [ ] New tests above all pass.
- [ ] `node scripts/check-schema-version.mjs` reports OK without
  fingerprint change (no projection schema changes expected).
- [ ] Admin can open `/classifier` in a fresh data-dir install, configure
  remote provider, save, click "Test classifier", see a verdict.
- [ ] Admin can switch to local mode, pick a catalog entry, save, click
  "Restart classifier worker", and see the worker restart in logs.
- [ ] After a config change without restart, the cockpit shows the
  "drifted" banner and the prior worker keeps using the old config
  (no live-swap).

## Open Questions

(All resolved with Jim before authoring this spec.)

1. **Live config changes vs restart-required.** → **Restart-required**
   (option a). Cockpit shows a "drift" banner when stored ≠ running
   config; "Restart classifier worker" button is the explicit
   transition.
2. **Local-model dashboard UI.** → **Select from `CATALOG`, custom
   field below.** Best ergonomics + escape hatch for experimental
   models.
3. **Env-var migration path.** → **Hard break.** CHANGELOG calls it
   out; a one-line boot notice catches operators who forget to
   migrate. No permanent migration code in tree.
4. **Self-test button.** → **Yes**, reusing `runSelfTest` from
   `@librarian/classifier`. Mirrors curator's run-now ergonomically.

## References

- `packages/core/src/curator-config.ts` — reference implementation.
- `packages/mcp-server/src/trpc/curator.ts` — reference tRPC router.
- `apps/dashboard/components/curator/config-form.tsx` — reference UI.
- `packages/mcp-server/src/classifier-startup.ts` — current env-driven boot.
- `packages/classifier/src/index.ts` — `runSelfTest`, `CATALOG`,
  `ProviderConfig`.
- `docs/specs/done/023-classifier-implementation-spec.md` — original classifier
  spec; §4.2 names the env contract this spec retires.

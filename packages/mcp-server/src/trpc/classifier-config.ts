// Classifier admin tRPC procedures — cockpit surface for the
// classifier worker's config, drift detection, restart, and self-test
// (see docs/specs/classifier-dashboard-config-spec.md).
//
// Five admin-gated procedures:
//
//   config         — read the current stored config (no token, only hasToken)
//   setConfig      — validated update; returns the fresh readable config
//   workerState    — running vs stored config hash + drift boolean for
//                    the dashboard's "Restart classifier worker" banner
//   restartWorker  — invoke restartClassifierWorker; coalesces concurrent
//                    callers via the single-flight mutex
//   selfTest       — runSelfTest against a transient classifier; doesn't
//                    touch the running worker
//
// There is deliberately NO consumer-agent surface — the classifier
// worker runs in-process and writes the verdict directly to the memory
// row via the queue; agents never call into this from MCP tools.

import {
  type ClassifierConfigPatch,
  ClassifierConfigPatchSchema,
  classifierConfigHash,
  readClassifierConfig,
  writeClassifierConfig,
} from "@librarian/core";
import {
  getRunningWorkerState,
  restartClassifierWorker,
  runClassifierSelfTest,
} from "../classifier-startup.js";
import { adminProcedure, router } from "./trpc.js";

export const classifierConfigRouter = router({
  // Current config (never includes the token — only `hasToken`).
  config: adminProcedure.query(({ ctx }) => readClassifierConfig(ctx.store)),

  // Update config; returns the fresh readable config. `writeClassifierConfig`
  // validates classifier-specific invariants (provider-mode enum,
  // promptVersion regex) and the shared LLM helper validates timeoutMs;
  // tokens are stored encrypted.
  setConfig: adminProcedure.input(ClassifierConfigPatchSchema).mutation(({ ctx, input }) => {
    // Cast at the validated boundary — Zod `.optional()` infers `T | undefined`,
    // which the patch type (optional-key, not undefined-value) rejects under
    // exactOptionalPropertyTypes.
    writeClassifierConfig(ctx.store, input as ClassifierConfigPatch);
    return readClassifierConfig(ctx.store);
  }),

  // Drift signal for the dashboard banner. Drift is meaningful when
  // the stored hash differs from what's running AND there's something
  // to do about it — either a running worker that needs to pick up new
  // config, or an operational stored config that should be started.
  workerState: adminProcedure.query(({ ctx }) => {
    const state = getRunningWorkerState();
    const storedConfigHash = classifierConfigHash(ctx.store);
    const cfg = readClassifierConfig(ctx.store);
    const hashesDiffer = state.runningConfigHash !== storedConfigHash;
    const actionable = state.runningConfigHash !== null || cfg.isOperational;
    return {
      runningConfigHash: state.runningConfigHash,
      storedConfigHash,
      hasDrift: hashesDiffer && actionable,
    };
  }),

  // Apply the current stored config. Concurrent calls coalesce onto
  // already_in_progress; see classifier-startup.ts shutdown deep-dive.
  restartWorker: adminProcedure.mutation(async ({ ctx }) =>
    restartClassifierWorker({
      store: ctx.store,
      appendEvent: (eventType, payload, options) => {
        ctx.store.appendEvent(eventType, payload, options);
      },
    }),
  ),

  // Run `runSelfTest(SELF_TEST_INPUT)` against a transient classifier.
  // Does not touch the running worker.
  selfTest: adminProcedure.mutation(async ({ ctx }) => runClassifierSelfTest({ store: ctx.store })),
});

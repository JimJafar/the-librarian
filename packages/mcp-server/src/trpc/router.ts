// tRPC app router.
//
// Composes the per-domain routers (memories, handoffs) plus health and
// admin surfaces. The `AppRouter` type is the public contract the
// dashboard imports.
//
// sessions-rethink PR 7 — the `sessions` router is retired with the
// rest of the session subsystem.

import { authRouter } from "./auth.js";
import { backupRouter } from "./backup.js";
import { classifierConfigRouter } from "./classifier-config.js";
import { classifierEvalRouter } from "./classifier-eval.js";
import { curatorRouter } from "./curator.js";
import { domainsRouter } from "./domains.js";
import { handoffsRouter } from "./handoffs.js";
import { healthRouter } from "./health.js";
import { memoriesRouter } from "./memories.js";
import { tokensRouter } from "./tokens.js";
import { router } from "./trpc.js";

export const appRouter = router({
  auth: authRouter,
  backup: backupRouter,
  classifierConfig: classifierConfigRouter,
  classifierEval: classifierEvalRouter,
  curator: curatorRouter,
  domains: domainsRouter,
  handoffs: handoffsRouter,
  health: healthRouter,
  memories: memoriesRouter,
  tokens: tokensRouter,
});

export type AppRouter = typeof appRouter;

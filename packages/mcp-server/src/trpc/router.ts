// tRPC app router.
//
// Composes the per-domain routers (memories, sessions) plus the
// health probe. T4.3 lands the scaffold only — memories/sessions are
// intentionally empty and get populated in T4.4 and T4.5. The
// `AppRouter` type is the public contract the dashboard imports.

import { authRouter } from "./auth.js";
import { backupRouter } from "./backup.js";
import { classifierEvalRouter } from "./classifier-eval.js";
import { curatorRouter } from "./curator.js";
import { domainsRouter } from "./domains.js";
import { handoffsRouter } from "./handoffs.js";
import { healthRouter } from "./health.js";
import { memoriesRouter } from "./memories.js";
import { sessionsRouter } from "./sessions.js";
import { tokensRouter } from "./tokens.js";
import { router } from "./trpc.js";

export const appRouter = router({
  auth: authRouter,
  backup: backupRouter,
  classifierEval: classifierEvalRouter,
  curator: curatorRouter,
  domains: domainsRouter,
  handoffs: handoffsRouter,
  health: healthRouter,
  memories: memoriesRouter,
  sessions: sessionsRouter,
  tokens: tokensRouter,
});

export type AppRouter = typeof appRouter;

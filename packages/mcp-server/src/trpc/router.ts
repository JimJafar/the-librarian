// tRPC app router.
//
// Composes the per-feature routers (memories, handoffs) plus health and
// admin surfaces. The `AppRouter` type is the public contract the
// dashboard imports.
//
// sessions-rethink PR 7 — the `sessions` router is retired with the
// rest of the session subsystem. D16 — the `domains` router is retired
// with the rest of the domain model.

import { authRouter } from "./auth.js";
import { backupRouter } from "./backup.js";
import { curatorRouter } from "./curator.js";
import { handoffsRouter } from "./handoffs.js";
import { healthRouter } from "./health.js";
import { llmRouter } from "./llm.js";
import { memoriesRouter } from "./memories.js";
import { tokensRouter } from "./tokens.js";
import { router } from "./trpc.js";

export const appRouter = router({
  auth: authRouter,
  backup: backupRouter,
  curator: curatorRouter,
  handoffs: handoffsRouter,
  health: healthRouter,
  llm: llmRouter,
  memories: memoriesRouter,
  tokens: tokensRouter,
});

export type AppRouter = typeof appRouter;

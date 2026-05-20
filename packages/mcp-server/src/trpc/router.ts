// tRPC app router.
//
// Composes the per-domain routers (memories, sessions) plus the
// health probe. T4.3 lands the scaffold only — memories/sessions are
// intentionally empty and get populated in T4.4 and T4.5. The
// `AppRouter` type is the public contract the dashboard imports.

import { healthRouter } from "./health.js";
import { memoriesRouter } from "./memories.js";
import { sessionsRouter } from "./sessions.js";
import { router } from "./trpc.js";

export const appRouter = router({
  health: healthRouter,
  memories: memoriesRouter,
  sessions: sessionsRouter,
});

export type AppRouter = typeof appRouter;

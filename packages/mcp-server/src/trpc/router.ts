// tRPC app router.
//
// Composes the per-feature routers (memories, handoffs) plus health and
// admin surfaces. The `AppRouter` type is the public contract the
// dashboard imports.
//
// sessions-rethink PR 7 — the `sessions` router is retired with the
// rest of the session subsystem. D16 — the `domains` router is retired
// with the rest of the domain model. The event ledger is gone; the
// vault's git history is the audit trail, surfaced by the `activity`
// router (rethink T21): the commit feed + the guarded whole-vault restore.

import { activityRouter } from "./activity.js";
import { addendumRouter } from "./addendum.js";
import { authRouter } from "./auth.js";
import { autoupdateRouter } from "./autoupdate.js";
import { awarenessRouter } from "./awareness.js";
import { backupRouter } from "./backup.js";
import { groomingRouter } from "./grooming.js";
import { handoffsRouter } from "./handoffs.js";
import { healthRouter } from "./health.js";
import { ingestRouter } from "./ingest.js";
import { intakeRouter } from "./intake.js";
import { llmRouter } from "./llm.js";
import { memoriesRouter } from "./memories.js";
import { tokensRouter } from "./tokens.js";
import { router } from "./trpc.js";
import { vaultRouter } from "./vault.js";

export const appRouter = router({
  activity: activityRouter,
  addendum: addendumRouter,
  auth: authRouter,
  autoupdate: autoupdateRouter,
  awareness: awarenessRouter,
  backup: backupRouter,
  grooming: groomingRouter,
  handoffs: handoffsRouter,
  health: healthRouter,
  ingest: ingestRouter,
  intake: intakeRouter,
  llm: llmRouter,
  memories: memoriesRouter,
  tokens: tokensRouter,
  vault: vaultRouter,
});

export type AppRouter = typeof appRouter;

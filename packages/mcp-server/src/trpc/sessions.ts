// Session tRPC procedures.
//
// Typed dashboard surface for sessions on appRouter.sessions: list,
// get, events, search, checkpoint, pause, end, archive, restore,
// delete, continue, promote.
//
// All procedures are admin-gated. Every store call is invoked with
// `admin: true` so visibility filtering is skipped — the admin
// bearer token is the access boundary, not per-row visibility.
//
// As with memories.ts, the store APIs in @librarian/core still accept
// loose record inputs; the `as Record<string, unknown>` casts at the
// boundary are safe because Zod validates first.

import { SessionPayloadTypeSchema, SessionStatusSchema } from "@librarian/core/schemas";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

const DASHBOARD_AGENT_ID = "dashboard";

const SessionIdInputSchema = z.object({ session_id: z.string().min(1) });

const ListSessionsInputSchema = z.object({
  project_key: z.string().optional(),
  harness: z.string().optional(),
  cwd: z.string().optional(),
  source_ref: z.string().optional(),
  status: z.array(SessionStatusSchema).optional(),
  include_archived: z.boolean().optional(),
  include_deleted: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const ListSessionEventsInputSchema = z.object({
  session_id: z.string().min(1),
  type: SessionPayloadTypeSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().nonnegative().optional(),
});

const SearchSessionsInputSchema = z.object({
  query: z.string().optional(),
  project_key: z.string().optional(),
  include_archived: z.boolean().optional(),
  include_deleted: z.boolean().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

// Lifecycle inputs (checkpoint, pause, end, archive, restore, delete).
// `candidate_memories` is read only by endSession; the field is present
// on the shared schema so clients see it in the typed surface, and the
// store silently ignores it for other lifecycle calls.
const SessionLifecycleInputSchema = z.object({
  session_id: z.string().min(1),
  agent_id: z.string().optional(),
  summary: z.string().optional(),
  decisions: z.array(z.string()).optional(),
  files_touched: z.array(z.string()).optional(),
  commands_run: z.array(z.string()).optional(),
  open_questions: z.array(z.string()).optional(),
  next_steps: z.array(z.string()).optional(),
  harness: z.string().optional(),
  source_ref: z.string().optional(),
  reason: z.string().optional(),
  candidate_memories: z.array(z.record(z.string(), z.unknown())).optional(),
});

const ContinueSessionInputSchema = z.object({
  session_id: z.string().min(1),
  agent_id: z.string().optional(),
  target_harness: z.string().optional(),
  target_cwd: z.string().optional(),
  target_source_ref: z.string().optional(),
  attach: z.boolean().optional(),
  format: z.enum(["prose", "markdown", "claude", "codex", "opencode", "hermes", "pi"]).optional(),
});

const PromoteSessionFactInputSchema = z.object({
  session_id: z.string().min(1),
  session_event_id: z.string().optional(),
  agent_id: z.string().optional(),
  memory: z.record(z.string(), z.unknown()),
});

type StoreLike = { getSession: (id: string) => unknown };
type AdminAction = (params: Record<string, unknown>) => unknown;

// Rewrap "No session found" Errors thrown by the store as NOT_FOUND so
// concurrent deletes between the pre-check and the action surface the
// right HTTP status. Anything else propagates as INTERNAL_SERVER_ERROR.
function runAdminAction(
  store: StoreLike,
  sessionId: string,
  agentId: string | undefined,
  body: Record<string, unknown>,
  action: AdminAction,
): unknown {
  if (!store.getSession(sessionId)) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
  }
  try {
    return action({
      ...body,
      session_id: sessionId,
      agent_id: agentId ?? DASHBOARD_AGENT_ID,
      admin: true,
    });
  } catch (error) {
    if (error instanceof Error && /No session found/i.test(error.message)) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
    }
    throw error;
  }
}

export const sessionsRouter = router({
  list: adminProcedure
    .input(ListSessionsInputSchema.optional())
    .query(({ ctx, input }) =>
      ctx.store.listSessions({ ...(input ?? {}), admin: true } as Record<string, unknown>),
    ),

  get: adminProcedure.input(SessionIdInputSchema).query(({ ctx, input }) => {
    const session = ctx.store.getSession(input.session_id);
    if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
    return session;
  }),

  events: adminProcedure.input(ListSessionEventsInputSchema).query(({ ctx, input }) => {
    if (!ctx.store.getSession(input.session_id)) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
    }
    return ctx.store.listSessionEvents({ ...input } as Record<string, unknown>);
  }),

  search: adminProcedure
    .input(SearchSessionsInputSchema.optional())
    .query(({ ctx, input }) =>
      ctx.store.searchSessions({ ...(input ?? {}), admin: true } as Record<string, unknown>),
    ),

  checkpoint: adminProcedure
    .input(SessionLifecycleInputSchema)
    .mutation(({ ctx, input }) =>
      runAdminAction(ctx.store, input.session_id, input.agent_id, input, (p) =>
        ctx.store.checkpointSession(p),
      ),
    ),

  pause: adminProcedure
    .input(SessionLifecycleInputSchema)
    .mutation(({ ctx, input }) =>
      runAdminAction(ctx.store, input.session_id, input.agent_id, input, (p) =>
        ctx.store.pauseSession(p),
      ),
    ),

  end: adminProcedure
    .input(SessionLifecycleInputSchema)
    .mutation(({ ctx, input }) =>
      runAdminAction(ctx.store, input.session_id, input.agent_id, input, (p) =>
        ctx.store.endSession(p),
      ),
    ),

  archive: adminProcedure
    .input(SessionLifecycleInputSchema)
    .mutation(({ ctx, input }) =>
      runAdminAction(ctx.store, input.session_id, input.agent_id, input, (p) =>
        ctx.store.archiveSession(p),
      ),
    ),

  restore: adminProcedure
    .input(SessionLifecycleInputSchema)
    .mutation(({ ctx, input }) =>
      runAdminAction(ctx.store, input.session_id, input.agent_id, input, (p) =>
        ctx.store.restoreSession(p),
      ),
    ),

  delete: adminProcedure
    .input(SessionLifecycleInputSchema)
    .mutation(({ ctx, input }) =>
      runAdminAction(ctx.store, input.session_id, input.agent_id, input, (p) =>
        ctx.store.deleteSession(p),
      ),
    ),

  continue: adminProcedure
    .input(ContinueSessionInputSchema)
    .mutation(({ ctx, input }) =>
      runAdminAction(ctx.store, input.session_id, input.agent_id, input, (p) =>
        ctx.store.continueSession(p),
      ),
    ),

  promote: adminProcedure
    .input(PromoteSessionFactInputSchema)
    .mutation(({ ctx, input }) =>
      runAdminAction(ctx.store, input.session_id, input.agent_id, input, (p) =>
        ctx.store.promoteSessionFact(p),
      ),
    ),
});

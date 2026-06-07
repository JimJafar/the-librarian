// Memory-curator admin tRPC procedures (memory-curator spec §7.1 / §13).
//
// The admin cockpit's typed surface: read/update the curator's NON-LLM config
// (enable flag, schedule, auto-apply posture), read-only run + operation
// observability, and the run-now control. All admin-gated — there is
// deliberately NO consumer-agent surface for curation (§12). The LLM connection
// is no longer part of this surface — named providers + per-consumer model
// selection live under the `llm` router (042 §4). The prompt addendum left this
// surface in spec 044 D-1 — it's a committed vault file now (its dashboard editor
// is D7); this router no longer reads or writes it.

import type {
  ChatGroomingOp,
  ChatIntakeOp,
  ChatJob,
  ChatMemoryGrounding,
  ChatResponse,
  CuratorConfigPatch,
  EvidenceSlice,
  LibrarianStore,
  ListCurationRunsInput,
  LlmClient,
} from "@librarian/core";
import {
  CuratorConfigPatchSchema,
  createCuratorLlmClient,
  dryRunGrooming,
  inferChatJob,
  readConsumerConfig,
  readCuratorConfig,
  readJobAddendum,
  resolveConsumerToken,
  runChatTurn,
  runCuratorTick,
  writeCuratorConfig,
} from "@librarian/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { logger } from "../logging.js";
import { adminProcedure, router } from "./trpc.js";

const ListRunsInputSchema = z.strictObject({
  status: z.string().optional(),
  trigger: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
});

// A slice key for the "dry-run this slice" path: the EvidenceSlice shape (kind +
// the one identifier that kind needs). projectKey is required for common_project,
// agentId for agent_private; common_global needs neither. Kept structural rather
// than a string key so the dashboard can build it from the slice it already shows.
const SliceKeySchema = z.strictObject({
  kind: z.enum(["common_project", "common_global", "agent_private"]),
  projectKey: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
});

// Input for curator.dryRunGrooming. The candidate is the UNCOMMITTED addendum text
// to preview; candidateLabel tags the throwaway batch; slice (optional) runs ONE
// slice synchronously (fast), else the whole corpus runs in the background.
const DryRunGroomingInputSchema = z.strictObject({
  candidateAddendum: z.string(),
  candidateLabel: z.string().min(1).optional(),
  slice: SliceKeySchema.optional(),
});

// Input for curator.chat (spec 044 D-6b). A request/response (NO streaming) chat
// turn: the conversation so far + an optional memory to ground in + an optional job
// override (inferred from the memory's decision history when unset).
const ChatRoleSchema = z.enum(["system", "user", "assistant"]);
const ChatInputSchema = z.strictObject({
  messages: z
    .array(z.strictObject({ role: ChatRoleSchema, content: z.string() }))
    .min(1)
    .max(50),
  memoryId: z.string().min(1).optional(),
  job: z.enum(["intake", "grooming"]).optional(),
});

// How many recent curation/consolidation runs to scan for a memory's decision
// history. The stores have no per-memory op index, so we scan recent runs and
// filter; a bounded scan keeps a chat turn fast on a large corpus (the history is
// grounding context, not an audit — recent decisions are what matter).
const CHAT_HISTORY_RUN_SCAN = 100;

/**
 * Gather a memory's grounding bundle — the memory itself + its grooming decisions
 * (curation ops whose source/target memory ids include it) + its intake decisions
 * (consolidation ops whose source/target id is it). Fail-soft: a missing memory or
 * any store hiccup returns null (the chat turn then runs un-grounded rather than
 * throwing — decision D-9 "degrade, never block").
 */
function gatherChatGrounding(store: LibrarianStore, memoryId: string): ChatMemoryGrounding | null {
  try {
    const memory = store.getMemory(memoryId);
    if (!memory) return null;

    const groomingOps: ChatGroomingOp[] = [];
    for (const run of store.listCurationRuns({ limit: CHAT_HISTORY_RUN_SCAN })) {
      for (const op of store.getCurationOperations(run.id)) {
        if (op.source_memory_ids.includes(memoryId) || op.target_memory_ids.includes(memoryId)) {
          groomingOps.push({
            operation_type: op.operation_type,
            status: op.status,
            rationale: op.rationale,
            source_memory_ids: op.source_memory_ids,
            target_memory_ids: op.target_memory_ids,
          });
        }
      }
    }

    const intakeOps: ChatIntakeOp[] = [];
    for (const run of store.listConsolidationRuns({ limit: CHAT_HISTORY_RUN_SCAN })) {
      for (const op of store.getConsolidationOperations(run.id)) {
        if (op.source_id === memoryId || op.target_id === memoryId) {
          intakeOps.push({
            action: op.action,
            outcome: op.outcome,
            rationale: op.rationale,
            target_id: op.target_id,
          });
        }
      }
    }

    return {
      memory: { id: memory.id, title: memory.title, body: memory.body, status: memory.status },
      groomingOps,
      intakeOps,
    };
  } catch (error) {
    // Fail-soft: grounding is best-effort. Never let a missing memory / store error
    // out of the chat turn — log + fall through to an un-grounded turn.
    logger.warn({ err: error, memoryId }, "curator.chat grounding failed; running un-grounded");
    return null;
  }
}

export const curatorRouter = router({
  // Current NON-LLM curator config.
  config: adminProcedure.query(({ ctx }) => readCuratorConfig(ctx.store)),

  // Update config; returns the fresh readable config. writeCuratorConfig validates
  // (addendum size, confidence range, interval).
  setConfig: adminProcedure.input(CuratorConfigPatchSchema).mutation(({ ctx, input }) => {
    // Cast at the validated boundary: Zod `.optional()` infers `T | undefined`,
    // which the patch type (optional-key, not undefined-value) rejects under
    // exactOptionalPropertyTypes. The schema already validated the shape.
    writeCuratorConfig(ctx.store, input as CuratorConfigPatch);
    return readCuratorConfig(ctx.store);
  }),

  // Observability: run history (most recent first) + per-run operations.
  runs: adminProcedure
    .input(ListRunsInputSchema.optional())
    .query(({ ctx, input }) => ctx.store.listCurationRuns((input ?? {}) as ListCurationRunsInput)),

  runOperations: adminProcedure
    .input(z.strictObject({ runId: z.string().min(1) }))
    .query(({ ctx, input }) => ctx.store.getCurationOperations(input.runId)),

  // Admin run-now: shares the scheduler enqueue path (manual trigger, bypasses the
  // input-hash skip so it re-grooms even unchanged slices). ADMIN OVERRIDE (spec 045
  // D-4) — `allowDisabled: true` drops the `config.enabled` gate so a DISABLED job
  // still grooms on demand; run-now goes through the tick directly so it ALSO bypasses
  // the scheduled due-check. The LLM-config/token gates inside the tick still apply,
  // so a disabled-but-unconfigured job surfaces `incomplete_config` / `no_token` (never
  // "disabled") for the dashboard (T11). Synchronous — the admin awaits the summary.
  runNow: adminProcedure.mutation(({ ctx }) =>
    runCuratorTick({ store: ctx.store, trigger: "manual", bypassSkip: true, allowDisabled: true }),
  ),

  // Grooming dry-run (spec 044 D-4): preview what a CANDIDATE (uncommitted) addendum
  // would do over the corpus, in propose-mode, WITHOUT committing the candidate live
  // and WITHOUT auto-applying anything. The candidate is threaded into the prompt
  // (redacted there) and NEVER written to the vault — the live addendum file/status/
  // version are untouched. Proposals are tagged dry-run (discardable). GROOMING ONLY
  // — intake input is consumed on apply (not replayable), so there is no intake dry-
  // run (the same reason intake has no re-evaluate). The dashboard buttons are D7.
  //
  // Two scopes:
  //  - slice given → run that ONE slice SYNCHRONOUSLY and return the result (the
  //    latency-sensitive "dry-run this slice" path the spec calls out as fast);
  //  - no slice → "dry-run everything" can be slow, so it must NOT block the request:
  //    run it as fire-and-forget background work and return a `{ started: true }` ack
  //    immediately. CAVEAT: there is NO progress handle — the admin polls the runs/
  //    proposals to see results. A failure in the background run is fail-soft (logged
  //    via the shared logger, never crashes the server).
  dryRunGrooming: adminProcedure
    .input(DryRunGroomingInputSchema)
    .mutation(async ({ ctx, input }) => {
      if (input.slice) {
        // Fast path: one slice, synchronous — the admin awaits the result.
        const slice: EvidenceSlice = {
          kind: input.slice.kind,
          ...(input.slice.projectKey !== undefined ? { projectKey: input.slice.projectKey } : {}),
          ...(input.slice.agentId !== undefined ? { agentId: input.slice.agentId } : {}),
        };
        return dryRunGrooming({
          store: ctx.store,
          candidateAddendum: input.candidateAddendum,
          ...(input.candidateLabel !== undefined ? { candidateLabel: input.candidateLabel } : {}),
          slice,
        });
      }
      // Whole-corpus path: fire-and-forget so the request returns fast. The run is
      // fail-soft inside `dryRunGrooming` (per-slice try/catch); we also guard the
      // promise so a top-level rejection (gating throw etc.) is logged, never unhandled.
      void dryRunGrooming({
        store: ctx.store,
        candidateAddendum: input.candidateAddendum,
        ...(input.candidateLabel !== undefined ? { candidateLabel: input.candidateLabel } : {}),
      }).catch((error: unknown) => {
        logger.error({ err: error }, "background grooming dry-run failed");
      });
      return { started: true };
    }),

  // Curator chat (spec 044 D-6b / decisions D-5/6/8/9/10): a request/response (NO
  // streaming) admin endpoint to discuss a memory — or chat generally — with the
  // curator LLM, GROUNDED in the memory + its real decision history, returning prose
  // OR a structured proposed action the admin then CONFIRMS.
  //
  // PROPOSE, NEVER EXECUTE (human-in-the-loop): a fix-now suggestion comes back as a
  // `proposed_action` whose `action` validates against the EXACT D5 memoriesRouter
  // input schema (merge / split / update / unmerge) — the dashboard passes it
  // straight to that mutation. This endpoint touches NO store memory; the admin
  // confirms and the existing mutation runs.
  //
  // LLM = the `chat` consumer (spec 044 D-6a), which falls back WHOLE-CONSUMER to
  // grooming when chat's own config is unset. Resolution mirrors the tick: read the
  // consumer config + decrypt its token + build the OpenAI-compatible client. The
  // bearer token never leaves the client (never logged, never in the prompt/response).
  //
  // Fail-soft throughout: a missing memory / empty history degrades to an un-grounded
  // turn; an unparseable / invalid model completion degrades to a `message`. The only
  // hard error is a non-runnable chat consumer (no provider/token) — there's nothing
  // to talk to, so we surface a clear PRECONDITION_FAILED rather than pretend.
  chat: adminProcedure
    .input(ChatInputSchema)
    .mutation(async ({ ctx, input }): Promise<ChatResponse> => {
      const llm = readConsumerConfig(ctx.store, "chat");
      if (!llm.isOperational) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "The chat LLM is not configured. Set the curator chat (or grooming) provider, model, and token first.",
        });
      }
      let token: string | null;
      try {
        token = resolveConsumerToken(ctx.store, "chat");
      } catch {
        token = null;
      }
      if (!token) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "The chat LLM provider has no decryptable token.",
        });
      }

      const buildClient =
        ctx.buildChatClient ??
        ((
          conn: { endpoint: string; model: string; timeoutMs: number },
          secret: string,
        ): LlmClient =>
          createCuratorLlmClient({
            endpoint: conn.endpoint,
            token: secret,
            model: conn.model,
            timeoutMs: conn.timeoutMs,
          }));
      const client = buildClient(
        { endpoint: llm.endpoint, model: llm.model, timeoutMs: llm.timeoutMs },
        token,
      );

      // Ground in the memory + its decision history (fail-soft: null → un-grounded).
      const grounding = input.memoryId ? gatherChatGrounding(ctx.store, input.memoryId) : null;

      // Infer-then-ask (decision D-9): use the caller's job if given, else infer it
      // from the memory's decision history, else default (grooming).
      const job: ChatJob =
        input.job ??
        (grounding
          ? inferChatJob({ groomingOps: grounding.groomingOps, intakeOps: grounding.intakeOps })
          : "grooming");

      // The committed addendum for the (inferred) job — advisory grounding, redacted
      // by the prompt builder. Fail-soft "" when absent.
      const addendum = readJobAddendum(ctx.store, job).content;

      return runChatTurn({
        client,
        ...(grounding ? { grounding } : {}),
        job,
        ...(addendum ? { addendum } : {}),
        messages: input.messages,
      });
    }),
});

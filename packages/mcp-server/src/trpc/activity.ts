// Vault activity feed + guarded whole-vault restore (rethink T21, spec §8 /
// D16). This surface IS the audit trail — curator/agent/admin provenance is
// derived server-side from the commit-subject conventions — and it fully
// replaces the retired event ledger's logs view.
//
// `restoreVault` owns the typed-confirmation gate (the dashboard modal makes
// the admin type RESTORE; the server validates it — a client can't skip the
// ceremony). The sequence itself (curator pause → pre-restore tag → ONE
// revert commit → index invalidation → resume, try/finally) lives on
// `store.restoreVaultTo`.
//
// Error mapping (teaching messages pass through verbatim):
//   wrong confirmation phrase, bad hash → BAD_REQUEST
//   unknown commit                      → NOT_FOUND
//   restore already running / curator run in flight → CONFLICT

import {
  CurationRunInFlightError,
  GitHashError,
  VaultRestoreInProgressError,
  VaultRestoreUnknownCommitError,
} from "@librarian/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

/** The phrase the admin must type into the restore modal. */
export const RESTORE_CONFIRMATION_PHRASE = "RESTORE";

const HashSchema = z
  .string()
  .regex(/^[0-9a-f]{7,40}$/i, "expected a git commit hash (7-40 hex characters)");

const FeedInputSchema = z
  .object({
    /** Page size (newest-first), clamped server-side to 200. */
    limit: z.number().int().min(1).max(200).optional(),
    /** Page cursor: only commits strictly older than this hash. */
    before: HashSchema.optional(),
  })
  .optional();

const RestoreInputSchema = z.object({
  hash: HashSchema,
  /** Must equal RESTORE_CONFIRMATION_PHRASE — the server-validated ceremony. */
  confirm: z.string(),
});

const CommitDiffInputSchema = z.object({ hash: HashSchema });

function rethrow(error: unknown): never {
  if (error instanceof GitHashError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }
  if (error instanceof VaultRestoreUnknownCommitError) {
    throw new TRPCError({ code: "NOT_FOUND", message: error.message });
  }
  if (error instanceof VaultRestoreInProgressError || error instanceof CurationRunInFlightError) {
    throw new TRPCError({ code: "CONFLICT", message: error.message });
  }
  throw error;
}

export const activityRouter = router({
  /** Recent vault commits, newest first, with files touched + provenance source. */
  feed: adminProcedure.input(FeedInputSchema).query(({ ctx, input }) => {
    try {
      return ctx.store.vaultActivity({
        ...(input?.limit !== undefined ? { limit: input.limit } : {}),
        ...(input?.before !== undefined ? { before: input.before } : {}),
      });
    } catch (error) {
      rethrow(error);
    }
  }),

  /**
   * Per-file diffs introduced by a single vault commit (rethink T21
   * activity-feed accordion). Returns the empty-files shape for an unknown
   * commit so the dashboard can render "no diff available" rather than
   * surface a not-found error mid-accordion expand.
   */
  commitDiff: adminProcedure.input(CommitDiffInputSchema).query(({ ctx, input }) => {
    try {
      return ctx.store.vaultCommitDiff(input.hash);
    } catch (error) {
      rethrow(error);
    }
  }),

  /**
   * Restore the whole vault to a commit's tree state — guarded (D16): typed
   * confirmation validated HERE, then curator pause → pre-restore tag → one
   * revert commit → index invalidation → curator resume on the store.
   */
  restoreVault: adminProcedure.input(RestoreInputSchema).mutation(async ({ ctx, input }) => {
    if (input.confirm !== RESTORE_CONFIRMATION_PHRASE) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          `whole-vault restore needs the confirmation phrase: type exactly ` +
          `'${RESTORE_CONFIRMATION_PHRASE}' (got '${input.confirm}'). This rolls every vault ` +
          `file back to that commit's state — as a new commit, so nothing is lost.`,
      });
    }
    try {
      return await ctx.store.restoreVaultTo(input.hash);
    } catch (error) {
      rethrow(error);
    }
  }),
});

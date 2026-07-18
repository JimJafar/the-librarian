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
  AuditCursorError,
  AuditSourceError,
  CurationRunInFlightError,
  GitHashError,
  RefusalDenialKindSchema,
  VaultRestoreInProgressError,
  VaultRestoreUnknownCommitError,
} from "@librarian/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { resolveActorDisplays } from "./actor-displays.js";
import { adminProcedure, memberProcedure, router } from "./trpc.js";

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

const AuditExportInputSchema = z
  .object({
    /** Page size in COMMITS, clamped server-side to 100 (half the 200 activity clamp). */
    limit: z.number().int().min(1).max(100).optional(),
    /** Cursor: only commits strictly older than this hash. */
    before: HashSchema.optional(),
    /** Opt in to per-file diffs — IGNORED for a non-admin caller (admin-only). */
    includeDiff: z.boolean().optional(),
  })
  .optional();

const RefusalsInputSchema = z
  .strictObject({
    /** Page size in refusal rows, capped at the sink reader's 200-row bound. */
    limit: z.number().int().min(1).max(200).optional(),
    /** Offset into the newest-first sequence after the optional kind filter. */
    offset: z.number().int().min(0).optional(),
    kind: RefusalDenialKindSchema.or(z.literal("dropped")).optional(),
  })
  .optional();

function rethrow(error: unknown): never {
  if (error instanceof GitHashError || error instanceof AuditCursorError) {
    // A malformed or stale cursor is the CALLER's mistake — a client error, never a 500.
    throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }
  if (error instanceof AuditSourceError) {
    // A broken `.git` is a SOURCE failure, not a bad request — a 500-class error.
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
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
   * The typed, shelf-safe, paginated AUDIT export (spec 064 T9 / SC 8–14): who SUCCESSFULLY
   * changed what, when, on which shelf. A THIN pass-through of `ctx.principal` to
   * `store.exportAudit` — the store does ALL gating from `principal.roles`, so this rides the
   * MEMBER tier (065's scoped-read surface): a member gets the redacted slice (actor + action +
   * subjectId + shelves + at), an admin the full record (paths/renames/diff), each scoped to the
   * caller's recall shelves. Moving to `memberProcedure` is legitimate under SC 6's rule because
   * the reads are principal-scoped in the SAME change.
   */
  auditExport: memberProcedure.input(AuditExportInputSchema).query(({ ctx, input }) => {
    try {
      const page = ctx.store.exportAudit(ctx.principal, {
        ...(input?.limit !== undefined ? { limit: input.limit } : {}),
        ...(input?.before !== undefined ? { before: input.before } : {}),
        ...(input?.includeDiff !== undefined ? { includeDiff: input.includeDiff } : {}),
      });
      const actorDisplays = resolveActorDisplays(
        ctx.actorDisplayProvider,
        page.events.flatMap((event) => (event.actor === null ? [] : [event.actor])),
      );
      return actorDisplays === undefined ? page : { ...page, actorDisplays };
    } catch (error) {
      rethrow(error);
    }
  }),

  /**
   * Bounded denial evidence (spec 071). Unlike the shelf-scoped success audit,
   * refusal evidence is intentionally cross-principal and can carry network
   * attribution, token hashes, and usernames. It therefore remains admin-only:
   * a member must never receive a misleading redacted half-log.
   */
  refusals: adminProcedure.input(RefusalsInputSchema).query(async ({ ctx, input }) => {
    const page = await ctx.store.readRefusals({
      ...(input?.limit !== undefined ? { limit: input.limit } : {}),
      ...(input?.offset !== undefined ? { offset: input.offset } : {}),
      ...(input?.kind !== undefined ? { kind: input.kind } : {}),
    });
    const actorDisplays = resolveActorDisplays(
      ctx.actorDisplayProvider,
      page.rows.flatMap((row) =>
        row.kind !== "dropped" && row.actorId !== undefined ? [row.actorId] : [],
      ),
    );
    return actorDisplays === undefined ? page : { ...page, actorDisplays };
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
      // A restore is the admin's own bytes → trailered with the acting principal (spec 064 SC 3).
      return await ctx.store.restoreVaultTo(input.hash, { actorId: ctx.principal.actorId });
    } catch (error) {
      rethrow(error);
    }
  }),
});

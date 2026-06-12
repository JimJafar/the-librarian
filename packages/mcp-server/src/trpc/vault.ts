// Vault explorer/editor tRPC procedures (rethink T18/T19, spec §8 / D15).
//
// The dashboard's Obsidian-lite surface over the whole vault. All procedures
// are admin-gated like the sibling routers; the heavy lifting (tree walk,
// lenient reads, per-kind save validation, compare-and-swap, wikilink-integrity
// renames, path discipline incl. traversal/symlink rejection) lives on
// `store.vaultFiles` — every mutation goes through the store layer (git commit
// per write + recall-index invalidation), never a raw fs write.
//
// Error mapping (teaching messages pass through verbatim):
//   bad/escaping path, invalid document  → BAD_REQUEST
//   absent file                          → NOT_FOUND
//   stale-hash save, create-over-existing → CONFLICT

import {
  GitHashError,
  VaultFileExistsError,
  VaultFileNotFoundError,
  VaultPathError,
  VaultValidationError,
  VaultWriteConflictError,
} from "@librarian/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

// Generous bound for a vault-relative path; the store re-validates shape.
const VaultPathSchema = z.string().min(1).max(512);

// 50 KB ceiling mirrors the largest document the system accepts elsewhere
// (store_handoff's document_md cap) — far above the 2 KB primer/addendum caps.
const RawContentSchema = z
  .string()
  .max(
    50_000,
    "vault documents are capped at 50,000 characters when edited through the dashboard — " +
      "a larger file (e.g. a big reference) can still be read and restored here, but must be " +
      "edited on disk",
  );

// A git commit hash — full or abbreviated, plain hex only (the store
// re-validates before anything reaches git's argv).
const HashSchema = z
  .string()
  .regex(/^[0-9a-f]{7,40}$/i, "expected a git commit hash (7-40 hex characters)");

const ReadInputSchema = z.object({ path: VaultPathSchema });
const AtCommitInputSchema = z.object({ path: VaultPathSchema, hash: HashSchema });
const DiffInputSchema = z.object({
  path: VaultPathSchema,
  /** Older side; omitted → the file's birth (whole file as additions). */
  from: HashSchema.optional(),
  /** Newer side; omitted → the working tree (current content). */
  to: HashSchema.optional(),
});
const WriteInputSchema = z.object({
  path: VaultPathSchema,
  raw: RawContentSchema,
  /** The content hash returned by `read` — supply it to make the save compare-and-swap. */
  expectedHash: z.string().optional(),
});
const CreateInputSchema = z.object({ path: VaultPathSchema, raw: RawContentSchema });
const RenameInputSchema = z.object({ from: VaultPathSchema, to: VaultPathSchema });
const ResolveInputSchema = z.object({ target: z.string().min(1).max(512) });

/** Map a vault-file store error onto the tRPC code the dashboard branches on. */
function rethrow(error: unknown): never {
  if (
    error instanceof VaultPathError ||
    error instanceof VaultValidationError ||
    error instanceof GitHashError
  ) {
    throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }
  if (error instanceof VaultFileNotFoundError) {
    throw new TRPCError({ code: "NOT_FOUND", message: error.message });
  }
  if (error instanceof VaultWriteConflictError || error instanceof VaultFileExistsError) {
    throw new TRPCError({ code: "CONFLICT", message: error.message });
  }
  throw error;
}

export const vaultRouter = router({
  /** The explorer tree: every visible vault entry (plumbing excluded), dirs first. */
  tree: adminProcedure.query(({ ctx }) => ctx.store.vaultFiles.tree()),

  /**
   * One file, explorer-shaped: raw text + lenient frontmatter + body, the
   * compare-and-swap hash, outbound wikilinks (resolved to vault paths) and
   * the backlinks pane's "what links here".
   */
  read: adminProcedure.input(ReadInputSchema).query(({ ctx, input }) => {
    try {
      const file = ctx.store.vaultFiles.readFile(input.path);
      return {
        ...file,
        links: ctx.store.vaultFiles.outboundLinks(file.path),
        backlinks: ctx.store.vaultFiles.backlinks(file.path),
      };
    } catch (error) {
      rethrow(error);
    }
  }),

  /** Resolve a wikilink target to a vault path (same alias/slug logic as links). */
  resolve: adminProcedure.input(ResolveInputSchema).query(({ ctx, input }) => ({
    path: ctx.store.vaultFiles.resolveLink(input.target),
  })),

  /** Overwrite an existing file — validated for its kind, optionally compare-and-swap. */
  write: adminProcedure.input(WriteInputSchema).mutation(({ ctx, input }) => {
    try {
      return ctx.store.vaultFiles.writeFile(
        input.path,
        input.raw,
        input.expectedHash !== undefined ? { expectedHash: input.expectedHash } : {},
      );
    } catch (error) {
      rethrow(error);
    }
  }),

  /** Create a new document (refused when the path exists). */
  create: adminProcedure.input(CreateInputSchema).mutation(({ ctx, input }) => {
    try {
      return ctx.store.vaultFiles.createFile(input.path, input.raw);
    } catch (error) {
      rethrow(error);
    }
  }),

  /** Move a file, rewriting wikilinks that target its old filename stem. */
  rename: adminProcedure.input(RenameInputSchema).mutation(({ ctx, input }) => {
    try {
      return ctx.store.vaultFiles.renameFile(input.from, input.to);
    } catch (error) {
      rethrow(error);
    }
  }),

  /** Hard-delete a document (recoverable from the vault's git history). */
  delete: adminProcedure.input(ReadInputSchema).mutation(({ ctx, input }) => {
    try {
      ctx.store.vaultFiles.deleteFile(input.path);
      return { deleted: input.path };
    } catch (error) {
      rethrow(error);
    }
  }),

  // ── per-file history / diff / restore (rethink T20, spec §8 / D16) ──────────

  /** The file's commits newest-first (follows renames; each entry carries its then-path). */
  history: adminProcedure.input(ReadInputSchema).query(({ ctx, input }) => {
    try {
      return ctx.store.vaultFiles.fileHistory(input.path);
    } catch (error) {
      rethrow(error);
    }
  }),

  /** The file's full content as of one commit (rename-aware). */
  atCommit: adminProcedure.input(AtCommitInputSchema).query(({ ctx, input }) => {
    try {
      return ctx.store.vaultFiles.fileAtCommit(input.path, input.hash);
    } catch (error) {
      rethrow(error);
    }
  }),

  /** Unified diff text for one file between two commits (or birth/worktree). */
  diff: adminProcedure.input(DiffInputSchema).query(({ ctx, input }) => {
    try {
      return {
        diff: ctx.store.vaultFiles.fileDiff(input.path, {
          ...(input.from !== undefined ? { from: input.from } : {}),
          ...(input.to !== undefined ? { to: input.to } : {}),
        }),
      };
    } catch (error) {
      rethrow(error);
    }
  }),

  /**
   * Restore the file to its content at `hash` — a NEW commit through the
   * validated store write path, never a history rewrite. A version that fails
   * the path's current validation is refused with the errors (teaching the
   * manual-edit path).
   */
  restoreVersion: adminProcedure.input(AtCommitInputSchema).mutation(({ ctx, input }) => {
    try {
      return ctx.store.vaultFiles.restoreFileVersion(input.path, input.hash);
    } catch (error) {
      rethrow(error);
    }
  }),
});

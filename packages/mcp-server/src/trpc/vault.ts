// Vault explorer tRPC procedures (rethink T18, spec §8 / D15).
//
// The dashboard's Obsidian-lite read surface over the whole vault. All
// procedures are admin-gated like the sibling routers; the heavy lifting
// (tree walk, lenient reads, wikilink resolution, path discipline incl.
// traversal/symlink rejection) lives on `store.vaultFiles`. The write side
// (validated saves, create/rename/delete) lands with T19.
//
// Error mapping (teaching messages pass through verbatim):
//   bad/escaping path → BAD_REQUEST · absent file → NOT_FOUND

import { VaultFileNotFoundError, VaultPathError } from "@librarian/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

// Generous bound for a vault-relative path; the store re-validates shape.
const VaultPathSchema = z.string().min(1).max(512);

const ReadInputSchema = z.object({ path: VaultPathSchema });
const ResolveInputSchema = z.object({ target: z.string().min(1).max(512) });

/** Map a vault-file store error onto the tRPC code the dashboard branches on. */
function rethrow(error: unknown): never {
  if (error instanceof VaultPathError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }
  if (error instanceof VaultFileNotFoundError) {
    throw new TRPCError({ code: "NOT_FOUND", message: error.message });
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
});

// Primer admin tRPC procedures (spec 041 A1, repointed by rethink T11).
//
// The primer is the one ≤2KB document teaching agents how to use The Librarian
// (spec §5.2). It lives at `vault/primer.md` — seeded on boot, git-committed on
// every save — and is served from that single source via the MCP `initialize`
// result's `instructions` field and the unauthenticated `GET /primer.md`
// endpoint. This is the dashboard's read/write surface over the file. It lives
// in its own router rather than under `curator` because the primer is
// harness-awareness, not a curator concern.
//
// Semantics: the read returns the file's content verbatim (the shipped default
// right after first boot); saving "" DISABLES the primer (no instructions
// field, an empty /primer.md). The ≤2KB cap is enforced by core's setPrimer;
// the over-cap throw is surfaced as a BAD_REQUEST so the dashboard shows the
// teaching message ("primer must be ≤ 2048 bytes…") instead of a 500.
// Admin-gated, mirroring the addendum router (`trpc/addendum.ts`).

import { readPrimer, setPrimer } from "@librarian/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

export const awarenessRouter = router({
  // The current primer (vault/primer.md verbatim — the dashboard pre-fills the
  // textarea with this). An operator-disabled primer reads back as "".
  primer: adminProcedure.query(({ ctx }) => ({ primer: readPrimer(ctx.store) })),

  // Save the primer to vault/primer.md (git-committed; the next MCP initialize
  // and /primer.md fetch serve it). "" disables it; over ≤2KB is refused.
  setPrimer: adminProcedure
    .input(z.strictObject({ primer: z.string() }))
    .mutation(({ ctx, input }) => {
      try {
        setPrimer(ctx.store, input.primer, ctx.principal.actorId);
      } catch (error) {
        throw new TRPCError({ code: "BAD_REQUEST", message: (error as Error).message });
      }
      return { primer: readPrimer(ctx.store) };
    }),
});

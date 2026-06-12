// Awareness-primer admin tRPC procedures (spec 041 PR-1 / Task A1).
//
// The awareness primer is a short, server-sourced note telling the model that
// The Librarian exists and which verbs to reach for. The per-turn conv_state
// delivery channel was deleted (rethink T2 / D10); TODO(rethink-T11): Phase 2
// serves the primer via the MCP `initialize` `instructions` field and
// `GET /primer.md`. This is a small admin surface — read the current primer
// (with the shipped default applied when unset), write a new one. It lives in
// its own router rather than under `curator` because the primer is
// harness-awareness, not a curator concern.
//
// Semantics (mirrors `readAwarenessPrimer`): the key unset reads back the shipped
// default; an explicit empty string DISABLES the primer; any other string is the
// operator's custom primer. The read is fail-soft (an unreadable store → "").
// Admin-gated, mirroring the grooming-config pattern (`trpc/grooming.ts`).

import { AWARENESS_PRIMER_KEY, readAwarenessPrimer } from "@librarian/core";
import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

export const awarenessRouter = router({
  // The current primer with the shipped default applied (the dashboard pre-fills
  // the textarea with this). An explicitly-cleared primer reads back as "".
  primer: adminProcedure.query(({ ctx }) => ({ primer: readAwarenessPrimer(ctx.store) })),

  // Set the primer text. "" DISABLES it (no block injected anywhere); any other
  // string is the operator's custom primer. Returns the fresh readable value.
  setPrimer: adminProcedure
    .input(z.strictObject({ primer: z.string() }))
    .mutation(({ ctx, input }) => {
      ctx.store.setSetting(AWARENESS_PRIMER_KEY, input.primer);
      return { primer: readAwarenessPrimer(ctx.store) };
    }),
});

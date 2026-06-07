// Awareness-primer admin tRPC procedures (spec 041 PR-1 / Task A1).
//
// The awareness primer is a short, server-sourced note injected on every harness
// turn telling the model that The Librarian exists and which verbs to reach for
// (A2 wires the read into `conv_state_get`; the five plugins render it). This is a
// small admin surface — read the current primer (with the shipped default applied
// when unset), write a new one. It lives in its own router rather than under
// `curator` because the primer is harness-awareness, not a curator concern.
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

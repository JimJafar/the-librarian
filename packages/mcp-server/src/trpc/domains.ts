// Domains admin tRPC router — memory-domain-isolation §4.1 + PR 4 / T4.1.
//
// Backs the dashboard's `/domains` page. Admin-only by design: the owner
// curates the domain list; agents never reach this surface (the
// `domain` field in `remember` is server-set from conv_state, not from
// a caller-supplied string).

import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

const DomainNameSchema = z.string().min(1).max(64);

export const domainsRouter = router({
  list: adminProcedure.query(({ ctx }) => ctx.store.domains.list()),

  add: adminProcedure
    .input(z.strictObject({ name: DomainNameSchema }))
    .mutation(({ ctx, input }) => ctx.store.domains.add(input.name)),

  remove: adminProcedure
    .input(z.strictObject({ name: DomainNameSchema }))
    .mutation(({ ctx, input }) => ctx.store.domains.remove(input.name)),
});

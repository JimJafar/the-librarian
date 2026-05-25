// tRPC initialiser.
//
// Pins the context type to `TrpcContext` so every router/procedure
// gets typed access to `role` and `store`. `adminProcedure` is the
// gateway middleware that future memory/session routers will use to
// require an admin bearer token; the public router for health probes
// stays on `publicProcedure`.

import { TRPCError, initTRPC } from "@trpc/server";
import type { TrpcContext } from "./context.js";

const t = initTRPC.context<TrpcContext>().create();

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;
export const publicProcedure = t.procedure;
export const adminProcedure = t.procedure.use(function requireAdmin(opts) {
  if (opts.ctx.role !== "admin") {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return opts.next({ ctx: opts.ctx });
});

// tRPC initialiser.
//
// Pins the context type to `TrpcContext` so every router/procedure
// gets typed access to `principal` and `store`. `adminProcedure` is the
// gateway middleware that memory/session routers use to require the admin
// role (spec 061 SC 5 — it gates on `principal.roles`, which the internal
// listener resolves to `["admin"]` by isolation); the public router for
// health probes stays on `publicProcedure`.

import { TRPCError, initTRPC } from "@trpc/server";
import type { TrpcContext } from "./context.js";

const t = initTRPC.context<TrpcContext>().create();

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;
export const publicProcedure = t.procedure;
export const adminProcedure = t.procedure.use(function requireAdmin(opts) {
  if (!opts.ctx.principal.roles.includes("admin")) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return opts.next({ ctx: opts.ctx });
});

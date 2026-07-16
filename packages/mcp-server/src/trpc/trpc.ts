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

/**
 * The SECOND procedure tier (spec 065 SC 6): admits the `member` OR `admin` role, rejects
 * everything else with `UNAUTHORIZED`. Admin passes because admin is TOTAL authority — a
 * `["member","admin"]` principal passes every adminProcedure too (`member` never narrows
 * `admin`; SC 5's admin-superset rule) — so a provider must mint `admin` only for principals
 * entitled to everything.
 *
 * THE RULE (SC 6, the reason the dashboard hole stays closed): moving a procedure from
 * `adminProcedure` to this tier is a deliberate PER-PROCEDURE act that must arrive WITH
 * principal-scoping of that procedure's reads in the SAME change — a member-reachable
 * procedure still calling vault-global store surfaces would reopen the confidentiality hole
 * this tier exists to close. 065 moves exactly four procedures (the memories browse slice);
 * everything else stays admin-gated until deliberately scoped.
 */
export const memberProcedure = t.procedure.use(function requireMember(opts) {
  const roles = opts.ctx.principal.roles;
  if (!roles.includes("member") && !roles.includes("admin")) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return opts.next({ ctx: opts.ctx });
});

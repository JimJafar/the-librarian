// D2.1: dashboard-managed-auth admin tRPC surface.
//
// The authenticated owner configures auth from the dashboard — enable/disable,
// password, OAuth creds + owner allowlist — over the existing admin-token proxy.
// Every procedure is admin-gated (agent-role callers can't reach it). `config`
// returns the resolved runtime config (incl. the HKDF-derived AUTH_SECRET the
// dashboard signs JWTs with); `verifyPassword` runs the store-side lockout. `enable`
// additionally requires the caller to present the admin token (timing-safe compare),
// closing the land-grab in the open pre-enforcement window.

import {
  assertPasswordPolicy,
  authenticateOwner,
  consumeSetupLink,
  enableAuth,
  getAuthConfig,
  ownerPasswordUsername,
  resetLockout,
  setEnabled,
  setOAuth,
  setOwner,
  setOwnerPassword,
} from "@librarian/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

const Provider = z.enum(["github", "google"]);

export const authRouter = router({
  // Resolved runtime config: enabled flag, methods, password username (never the
  // hash), decrypted OAuth creds, owner allowlist, and the derived AUTH_SECRET.
  config: adminProcedure.query(({ ctx }) => getAuthConfig(ctx.store, ctx.secretKey)),

  // Flip enforcement on — gated by a timing-safe admin-token match AND a complete
  // config (validated in core before the flag flips).
  enable: adminProcedure
    .input(z.strictObject({ adminToken: z.string().min(1) }))
    .mutation(({ ctx, input }) => {
      const result = enableAuth(ctx.store, {
        presentedAdminToken: input.adminToken,
        expectedAdminToken: ctx.adminToken,
        secretKey: ctx.secretKey,
      });
      if (!result.ok) {
        throw new TRPCError({
          code: result.error === "bad_admin_token" ? "UNAUTHORIZED" : "BAD_REQUEST",
          message:
            result.error === "bad_admin_token"
              ? "admin token does not match"
              : "auth config is incomplete (need a usable method and a master key)",
        });
      }
      return { enabled: true };
    }),

  // Break-glass: ungated off (a locked-out owner must always be able to turn it off).
  disable: adminProcedure.mutation(({ ctx }) => {
    setEnabled(ctx.store, false);
    return { enabled: false };
  }),

  setPassword: adminProcedure
    .input(z.strictObject({ username: z.string().min(1), password: z.string().min(1) }))
    .mutation(({ ctx, input }) => {
      try {
        setOwnerPassword(ctx.store, input.username, input.password);
      } catch (error) {
        // Surface the length-floor / username policy as a 400, not a 500.
        throw new TRPCError({ code: "BAD_REQUEST", message: (error as Error).message });
      }
      return { ok: true };
    }),

  configureOAuth: adminProcedure
    .input(
      z.strictObject({
        provider: Provider,
        clientId: z.string().min(1),
        clientSecret: z.string().min(1),
      }),
    )
    .mutation(({ ctx, input }) => {
      setOAuth(ctx.store, input.provider, {
        clientId: input.clientId,
        clientSecret: input.clientSecret,
      });
      return { ok: true };
    }),

  setOwner: adminProcedure
    .input(z.strictObject({ provider: Provider, ownerId: z.string().min(1) }))
    .mutation(({ ctx, input }) => {
      setOwner(ctx.store, input.provider, input.ownerId);
      return { ok: true };
    }),

  // Store-side password check with lockout — the dashboard Credentials provider
  // (D3) calls this; the hash and failure counters never leave the store.
  verifyPassword: adminProcedure
    .input(z.strictObject({ username: z.string().min(1), password: z.string().min(1) }))
    .mutation(({ ctx, input }) => authenticateOwner(ctx.store, input.username, input.password)),

  // Consume a one-time setup link (from `auth reset-password --print-setup-link`)
  // and set a new password. The dashboard reset page calls this server-side; the
  // link token is the user-facing credential. Validate the password BEFORE consuming
  // so a rejected attempt leaves the (single-use) link still usable.
  redeemSetupLink: adminProcedure
    .input(
      z.strictObject({
        token: z.string().min(1),
        username: z.string().min(1).optional(),
        password: z.string().min(1),
      }),
    )
    .mutation(({ ctx, input }) => {
      try {
        assertPasswordPolicy(input.password);
      } catch (error) {
        throw new TRPCError({ code: "BAD_REQUEST", message: (error as Error).message });
      }
      // Resolve the username before consuming so a missing one doesn't waste the
      // single-use link. This leaks "is a username configured" to an unauthenticated
      // caller, but the owner username is effectively public for a single-owner
      // deployment, so the better UX (don't burn the link) wins.
      const username = input.username?.trim() || ownerPasswordUsername(ctx.store) || "";
      if (!username) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "a username is required" });
      }
      if (!consumeSetupLink(ctx.store, input.token)) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "setup link is invalid, expired, or already used",
        });
      }
      setOwnerPassword(ctx.store, username, input.password);
      resetLockout(ctx.store);
      return { ok: true };
    }),
});

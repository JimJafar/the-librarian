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
  type BootstrapClaimHandle,
  type Principal,
  BootstrapClaimTokenError,
  assertPasswordPolicy,
  authenticateOwner,
  consumeSetupLink,
  createInertBootstrapClaimHandle,
  enableAuth,
  getAuthConfig,
  isAuthConfigComplete,
  ownerPasswordUsername,
  resetLockout,
  setEnabled,
  setOAuth,
  setOwner,
  setOwnerPassword,
} from "@librarian/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { TrpcContext } from "./context.js";
import { adminProcedure, router } from "./trpc.js";

const Provider = z.enum(["github", "google"]);
const GENERIC_CLAIM_REFUSAL = "claim invalid, already used, or not armed";

// Keep direct, pre-spec-070 router callers compatible at runtime. Production always
// supplies the process-wide handle through createContextFactory; an absent handle
// is treated exactly like the env being unset.
function claimHandle(ctx: { bootstrapClaim?: BootstrapClaimHandle }): BootstrapClaimHandle {
  return ctx.bootstrapClaim ?? createInertBootstrapClaimHandle();
}

function principalEvidence(principal: Principal) {
  return {
    actorId: principal.actorId,
    roles: [...principal.roles],
    ...(principal.tokenId === undefined ? {} : { tokenId: principal.tokenId }),
  };
}

function refuseClaim(
  ctx: Pick<TrpcContext, "principal" | "store">,
  message: string = GENERIC_CLAIM_REFUSAL,
): never {
  void ctx.store.recordRefusal({
    kind: "claim-refused",
    surface: "internal",
    outcome: 401,
    ...principalEvidence(ctx.principal),
  });
  throw new TRPCError({ code: "UNAUTHORIZED", message });
}

export const authRouter = router({
  // Resolved runtime config: enabled flag, methods, password username (never the
  // hash), decrypted OAuth creds, owner allowlist, and the derived AUTH_SECRET.
  config: adminProcedure.query(({ ctx }) => {
    const config = getAuthConfig(ctx.store, ctx.secretKey);
    const handle = claimHandle(ctx);
    return {
      ...config,
      // Short-circuit on `armed` so an unset env never consults claim state.
      claimPending: handle.armed && handle.claimPending(ctx.store),
    };
  }),

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
        void ctx.store.recordRefusal({
          kind: "enable-refused",
          surface: "internal",
          outcome: result.error === "bad_admin_token" ? 401 : "refused",
          ...principalEvidence(ctx.principal),
        });
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
    .mutation(({ ctx, input }) => {
      const result = authenticateOwner(ctx.store, input.username, input.password);
      if (!result.ok) {
        const configuredUsername = ownerPasswordUsername(ctx.store);
        const username =
          configuredUsername !== null && input.username === configuredUsername
            ? input.username
            : "<unknown-user>";
        void ctx.store.recordRefusal({
          kind: result.locked ? "password-lockout" : "password-failed",
          surface: "internal",
          outcome: result.locked ? "locked" : "refused",
          username,
          ...principalEvidence(ctx.principal),
        });
      }
      return result;
    }),

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
        void ctx.store.recordRefusal({
          kind: "setup-link-refused",
          surface: "internal",
          outcome: 401,
          ...principalEvidence(ctx.principal),
        });
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "setup link is invalid, expired, or already used",
        });
      }
      setOwnerPassword(ctx.store, username, input.password);
      resetLockout(ctx.store);
      return { ok: true };
    }),

  // First-owner claim (spec 070). Deliberately synchronous from the first gate
  // through the burn: SettingsLike and the sidecar write are synchronous, so two
  // calls in one process cannot interleave between ownership checks and effects.
  redeemBootstrapClaim: adminProcedure
    .input(z.strictObject({ token: z.string().min(1), password: z.string().min(1) }))
    .mutation(({ ctx, input }) => {
      const handle = claimHandle(ctx);

      // Burn and ownership are checked before token verification so neither state
      // becomes an oracle about whether a presented token was otherwise valid.
      if (!handle.armed || handle.isBurned()) refuseClaim(ctx);
      const currentConfig = getAuthConfig(ctx.store, ctx.secretKey);
      if (currentConfig.enabled) refuseClaim(ctx);

      let claim;
      try {
        claim = handle.verify(input.token);
      } catch (error) {
        if (error instanceof BootstrapClaimTokenError && error.code === "expired") {
          refuseClaim(ctx, "claim expired");
        }
        refuseClaim(ctx);
      }

      try {
        assertPasswordPolicy(input.password);
      } catch (error) {
        throw new TRPCError({ code: "BAD_REQUEST", message: (error as Error).message });
      }

      // Prove the config will be usable BEFORE hashing/persisting a password. The
      // claim itself supplies the password method; the remaining prerequisite is a
      // derivable auth secret.
      if (
        !isAuthConfigComplete({
          ...currentConfig,
          methods: currentConfig.methods.includes("password")
            ? currentConfig.methods
            : [...currentConfig.methods, "password"],
          password: { username: claim.email },
        })
      ) {
        refuseClaim(ctx);
      }

      // Effect order is load-bearing for crash recovery:
      // password-only => disabled and re-redeemable; enabled => owned; burn commits
      // the receipt. Do not add an await anywhere in this sequence.
      setOwnerPassword(ctx.store, claim.email, input.password);
      resetLockout(ctx.store);
      if (!isAuthConfigComplete(getAuthConfig(ctx.store, ctx.secretKey))) refuseClaim(ctx);
      setEnabled(ctx.store, true);
      const burn = handle.burn(claim.email);
      const receipt = handle.mintReceipt({ email: claim.email, claimedAt: burn.claimedAt });

      return {
        ok: true,
        email: claim.email,
        returnTo: claim.returnTo ?? null,
        receipt,
        claimedAt: burn.claimedAt,
      };
    }),
});

"use server";

import { bareServerTRPC } from "@/lib/trpc-server-bare";

// D4.3: consume a one-time setup link and set a new password. Reached by a
// locked-out owner with NO session (this route is excluded from the auth
// middleware), so the link token — single-use, short-TTL, validated store-side — is
// the credential. The server action runs with the admin tRPC client; redeemSetupLink
// validates the password, consumes the link, sets the password, and clears lockout.
//
// spec 065 SC 3: this redemption rides the BARE bootstrap client. It is sessionless BY DESIGN
// (break-glass account recovery), so under the identity-bearing serverTRPC it would carry the
// anonymous assertion and every member-aware deployment would refuse account recovery (the spec
// 065 verify-pass-2 blocker). Its real credential is the link token, validated store-side —
// machine trust (an absent assertion) is the honest classification, same as verifyPassword.

export type RedeemResetResult = { ok: true } | { ok: false; error: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function redeemResetAction(input: {
  token: string;
  username?: string;
  password: string;
}): Promise<RedeemResetResult> {
  try {
    const username = input.username?.trim();
    await bareServerTRPC.auth.redeemSetupLink.mutate({
      token: input.token,
      password: input.password,
      ...(username ? { username } : {}),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

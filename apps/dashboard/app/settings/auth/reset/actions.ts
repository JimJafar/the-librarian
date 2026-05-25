"use server";

import { serverTRPC } from "@/lib/trpc-server";

// D4.3: consume a one-time setup link and set a new password. Reached by a
// locked-out owner with NO session (this route is excluded from the auth
// middleware), so the link token — single-use, short-TTL, validated store-side — is
// the credential. The server action runs with the admin tRPC client; redeemSetupLink
// validates the password, consumes the link, sets the password, and clears lockout.

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
    await serverTRPC.auth.redeemSetupLink.mutate({
      token: input.token,
      password: input.password,
      ...(username ? { username } : {}),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

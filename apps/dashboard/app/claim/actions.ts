"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { type ClaimRedemptionResult, claimClientKey, redeemClaim } from "@/lib/claim-redemption";

export type ClaimActionState =
  | { status: "idle" }
  | Exclude<ClaimRedemptionResult, { status: "redirect" }>;

export async function redeemClaimAction(
  _previous: ClaimActionState,
  formData: FormData,
): Promise<ClaimActionState> {
  const result = await redeemClaim(
    {
      token: formData.get("token"),
      password: formData.get("password"),
      confirm: formData.get("confirm"),
    },
    claimClientKey(await headers()),
  );
  if (result.status !== "redirect") return result;
  // Next 15 redirect() throws by design; keep it outside every try/catch.
  redirect(result.location);
}

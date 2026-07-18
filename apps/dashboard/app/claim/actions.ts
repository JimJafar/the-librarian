"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { signIn } from "@/auth";
import { bustAuthConfig } from "@/lib/auth-config-client";
import { createRateLimiter } from "@/lib/rate-limit";
import { bareServerTRPC } from "@/lib/trpc-server-bare";

export type ClaimActionState =
  | { status: "idle" }
  | { status: "error"; error: string; httpStatus?: 429 }
  | { status: "claimed"; loginHref: "/login"; continueUrl: string | null };

const GENERIC_REFUSAL = "claim invalid, already used, or not armed";
const RATE_LIMIT = Number(process.env.LIBRARIAN_CLAIM_RATE_LIMIT) || 10;
const limiter = createRateLimiter({ limit: RATE_LIMIT, windowMs: 60_000 });

async function clientKey(): Promise<string> {
  const requestHeaders = await headers();
  // Best-effort only: this throttle assumes the edge overwrites XFF. The signed
  // claim remains the real gate; a spoofable key can only evade this local bound.
  const forwarded = requestHeaders.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || requestHeaders.get("x-real-ip") || "global";
}

function disclosedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === GENERIC_REFUSAL || message === "claim expired") return message;
  if (/^password must be at least \d+ characters$/.test(message)) return message;
  return GENERIC_REFUSAL;
}

function receiptDestination(returnTo: string | null, receipt: string): string | null {
  if (!returnTo) return null;
  try {
    const destination = new URL(returnTo);
    if (destination.protocol !== "https:") return null;
    destination.searchParams.set("claim_receipt", receipt);
    return destination.toString();
  } catch {
    return null;
  }
}

function signInSucceeded(result: unknown): boolean {
  if (typeof result !== "string") return false;
  try {
    const destination = new URL(result, "http://dashboard.local");
    return destination.pathname === "/" && !destination.searchParams.has("error");
  } catch {
    return false;
  }
}

export async function redeemClaimAction(
  _previous: ClaimActionState,
  formData: FormData,
): Promise<ClaimActionState> {
  if (!limiter.check(await clientKey())) {
    return {
      status: "error",
      error: "Too many claim attempts. Please wait and request a fresh link.",
      httpStatus: 429,
    };
  }

  const token = formData.get("token");
  const password = formData.get("password");
  const confirm = formData.get("confirm");
  if (typeof token !== "string" || !token || typeof password !== "string" || !password) {
    return { status: "error", error: GENERIC_REFUSAL };
  }
  if (password !== confirm) {
    return { status: "error", error: "Passwords do not match." };
  }

  let claimed;
  try {
    claimed = await bareServerTRPC.auth.redeemBootstrapClaim.mutate({ token, password });
  } catch (error) {
    return { status: "error", error: disclosedMessage(error) };
  }

  bustAuthConfig();
  let sessionEstablished = false;
  try {
    const result = await signIn("credentials", {
      username: claimed.email,
      password,
      redirect: false,
      redirectTo: "/",
    });
    sessionEstablished = signInSucceeded(result);
  } catch {
    // Ownership is already committed. Never turn a session-establishment failure
    // into a second claim attempt; give the owner a warm /login fallback instead.
  }

  const continueUrl = receiptDestination(claimed.returnTo, claimed.receipt);
  if (!sessionEstablished) {
    return { status: "claimed", loginHref: "/login", continueUrl };
  }

  // Next 15 redirect() throws by design; keep it outside every try/catch.
  redirect(continueUrl ?? "/");
}

"use server";

import { revalidatePath } from "next/cache";
import { bustAuthConfig } from "@/lib/auth-config-client";
import { serverTRPC } from "@/lib/trpc-server";

// D5: server actions for the auth setup wizard. Each wraps an admin auth.* mutation
// and busts the in-process auth-config cache so the change takes effect at once
// (rather than waiting out the TTL), then revalidates the settings page.

export type AuthActionResult = { ok: true } | { ok: false; error: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function run(mutation: () => Promise<unknown>): Promise<AuthActionResult> {
  try {
    await mutation();
    bustAuthConfig();
    revalidatePath("/settings/auth");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

export function enableAuthAction(adminToken: string): Promise<AuthActionResult> {
  return run(() => serverTRPC.auth.enable.mutate({ adminToken }));
}

export function disableAuthAction(): Promise<AuthActionResult> {
  return run(() => serverTRPC.auth.disable.mutate());
}

export function setPasswordAction(input: {
  username: string;
  password: string;
}): Promise<AuthActionResult> {
  return run(() => serverTRPC.auth.setPassword.mutate(input));
}

export function configureOAuthAction(input: {
  provider: "github" | "google";
  clientId: string;
  clientSecret: string;
}): Promise<AuthActionResult> {
  return run(() => serverTRPC.auth.configureOAuth.mutate(input));
}

export function setOwnerAction(input: {
  provider: "github" | "google";
  ownerId: string;
}): Promise<AuthActionResult> {
  return run(() => serverTRPC.auth.setOwner.mutate(input));
}

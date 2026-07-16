import "server-only";
// The owner-password verify seam (spec 065 SC 3 / review finding F1).
//
// verifyPassword is the third sessionless bootstrap flow: it runs BEFORE any session exists — its
// credential is the password being verified — so it MUST ride the BARE bootstrap client, never the
// identity-bearing serverTRPC (whose headers callback calls auth(), which would both re-enter the
// lazy auth config AND, under a member-aware provider, assert anonymity on this pre-session call and
// refuse it — breaking sign-in). This lives in its own module (not inline in auth.ts) so the wiring
// can be pinned by a test without importing NextAuth: a regression back to serverTRPC fails loudly.
import { bareServerTRPC } from "@/lib/trpc-server-bare";

export const verifyOwnerPassword = (username: string, password: string): Promise<{ ok: boolean }> =>
  bareServerTRPC.auth.verifyPassword.mutate({ username, password });

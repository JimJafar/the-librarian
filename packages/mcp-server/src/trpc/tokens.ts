// A5: agent-token management admin tRPC procedures (single-owner-auth spec).
//
// The authenticated owner mints/revokes DB-stored agent tokens from the dashboard
// instead of hand-editing LIBRARIAN_AGENT_TOKENS + restarting. All admin-gated —
// agent-role callers cannot reach this surface. `create` returns the plaintext
// token exactly ONCE (core stores only a salted hash); `list` returns metadata
// only. Tokens authenticate on /mcp immediately, with no restart (see A4).

import { createAgentToken, listAgentTokens, revokeAgentToken } from "@librarian/core";
import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

const CreateInput = z.strictObject({
  agentId: z.string().min(1).max(128),
  label: z.string().max(200).optional(),
});

export const tokensRouter = router({
  // Metadata only — never the token, hash, or salt.
  list: adminProcedure.query(({ ctx }) => listAgentTokens(ctx.store)),

  // Mint a token; the plaintext in the response is shown once and not recoverable.
  create: adminProcedure.input(CreateInput).mutation(({ ctx, input }) =>
    // Cast at the validated boundary: Zod `.optional()` infers `label: string |
    // undefined`, which the param type (optional key) rejects under
    // exactOptionalPropertyTypes. The schema already validated the shape.
    createAgentToken(ctx.store, input as { agentId: string; label?: string }),
  ),

  // Revoke by id; returns whether a record was actually removed.
  revoke: adminProcedure
    .input(z.strictObject({ id: z.string().min(1) }))
    .mutation(({ ctx, input }) => ({ revoked: revokeAgentToken(ctx.store, input.id) })),
});

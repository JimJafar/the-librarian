// A5: agent-token management cockpit. The owner mints/revokes DB-stored agent
// tokens here instead of hand-editing LIBRARIAN_AGENT_TOKENS. Tokens authenticate
// on /mcp immediately (no restart); the plaintext is shown once on creation.

import { createTokenAction, revokeTokenAction } from "./actions";
import { GenerateTokenForm } from "@/components/tokens/generate-form";
import { TokenList } from "@/components/tokens/token-list";
import { serverTRPC } from "@/lib/trpc-server";

export const dynamic = "force-dynamic";

export default async function TokensPage() {
  let tokens: Awaited<ReturnType<typeof serverTRPC.tokens.list.query>> = [];
  let error: string | null = null;
  try {
    tokens = await serverTRPC.tokens.list.query();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return (
    <main className="flex flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Agent tokens</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Mint a token per agent, then paste it into that client once. Revoking takes effect on{" "}
          <code className="font-mono">/mcp</code> immediately.
        </p>
      </header>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <GenerateTokenForm onCreate={createTokenAction} />
      <section className="rounded-md border bg-card p-4" aria-label="Active tokens">
        <h2 className="mb-3 font-semibold">Active tokens</h2>
        <TokenList tokens={tokens} onRevoke={revokeTokenAction} />
      </section>
    </main>
  );
}

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
    <main className="flex flex-col gap-5 p-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-xl text-foreground">Agent tokens</h1>
        <p className="text-sm text-foreground/60">
          Mint a token per agent, then paste it into that client once. Revoking takes effect on{" "}
          <code className="font-mono text-foreground/80">/mcp</code> immediately.
        </p>
      </header>
      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          Failed to load tokens: {error}
        </p>
      ) : null}
      <GenerateTokenForm onCreate={createTokenAction} />
      <section className="border border-ink-hairline bg-ink-surface p-4" aria-label="Active tokens">
        <h2 className="mb-3 font-display text-lg text-foreground">Active tokens</h2>
        <TokenList tokens={tokens} onRevoke={revokeTokenAction} />
      </section>
    </main>
  );
}

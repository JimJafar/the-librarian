"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { RevokeTokenResult } from "@/app/tokens/actions";

interface TokenMeta {
  id: string;
  agentId: string;
  label: string;
  created_at: string;
}

// The active-token list. Metadata only (the secret is never sent here); each row
// can be revoked, which takes effect on /mcp immediately (no restart).
export function TokenList({
  tokens,
  onRevoke,
}: {
  tokens: TokenMeta[];
  onRevoke: (id: string) => Promise<RevokeTokenResult>;
}) {
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const revoke = (id: string) =>
    startTransition(async () => {
      setError(null);
      setBusyId(id);
      const res = await onRevoke(id);
      setBusyId(null);
      if (res.ok) router.refresh();
      else setError(res.error);
    });

  if (tokens.length === 0) {
    return <p className="text-sm text-muted-foreground">No agent tokens yet.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {error ? <p className="text-sm text-destructive">Error: {error}</p> : null}
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="py-1 font-medium">Agent</th>
            <th className="py-1 font-medium">Label</th>
            <th className="py-1 font-medium">Created</th>
            <th className="py-1" />
          </tr>
        </thead>
        <tbody>
          {tokens.map((token) => (
            <tr key={token.id} className="border-t">
              <td className="py-1.5 font-mono">{token.agentId}</td>
              <td className="py-1.5 text-muted-foreground">{token.label || "—"}</td>
              <td className="py-1.5 text-muted-foreground">{token.created_at}</td>
              <td className="py-1.5 text-right">
                <button
                  type="button"
                  onClick={() => revoke(token.id)}
                  disabled={pending && busyId === token.id}
                  className="rounded-md border px-2 py-1 text-sm hover:bg-muted disabled:opacity-50"
                >
                  {pending && busyId === token.id ? "Revoking…" : "Revoke"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { RevokeTokenResult } from "@/app/settings/tokens/actions";
import { Button } from "@/components/ui-v2/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui-v2/table";

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
    return <p className="text-sm text-foreground/60">No agent tokens yet.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          Error: {error}
        </p>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Agent</TableHead>
            <TableHead>Label</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tokens.map((token) => (
            <TableRow key={token.id}>
              <TableCell className="font-mono text-xs text-foreground">{token.agentId}</TableCell>
              <TableCell className="text-xs text-foreground/70">{token.label || "—"}</TableCell>
              <TableCell className="font-mono text-xs text-foreground/70">
                {token.created_at}
              </TableCell>
              <TableCell className="text-right">
                <Button
                  variant="destructive"
                  onClick={() => revoke(token.id)}
                  disabled={pending && busyId === token.id}
                >
                  {pending && busyId === token.id ? "Revoking…" : "Revoke"}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { RevokeCaptureTokenResult } from "@/app/settings/connect/actions";
import { Button } from "@/components/ui-v2/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui-v2/table";

interface CaptureTokenMeta {
  id: string;
  agentId: string;
  label: string;
  created_at: string;
}

// The active capture-token list (already filtered to `scope === "capture"` by
// the page). Metadata only — the secret is never sent here. Revoking takes
// effect on the capture surface immediately (no restart).
export function CaptureTokenList({
  tokens,
  onRevoke,
}: {
  tokens: CaptureTokenMeta[];
  onRevoke: (id: string) => Promise<RevokeCaptureTokenResult>;
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
    return <p className="text-sm text-foreground/60">No capture tokens yet.</p>;
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
            <TableHead>Device</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tokens.map((token) => (
            <TableRow key={token.id}>
              <TableCell className="text-xs text-foreground">
                {token.label || token.agentId}
              </TableCell>
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

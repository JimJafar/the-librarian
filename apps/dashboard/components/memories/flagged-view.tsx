// Flagged review queue (spec 048 PR-2): list every memory an agent has flagged
// for review, surfacing the title, body, and each open flag's reason + flagger,
// with per-row Dismiss / Archive actions. A flag never changes a memory's
// status — these stay active until an admin adjudicates here. Dismiss clears the
// flags and keeps the memory; Archive archives it then clears the flags. Both
// go through the `resolveFlagAction` server action, then refetch the queue.

"use client";

import { useTransition } from "react";
import type { MemoryRow } from "./types";
import { resolveFlagAction } from "@/app/(memories)/actions";
import { Button } from "@/components/ui-v2/button";
import { trpc } from "@/lib/trpc-client";

interface MemoryFlag {
  agent_id: string;
  reason: string;
  created_at: string;
}

type FlaggedRow = MemoryRow & { flags?: MemoryFlag[] };

export function FlaggedView() {
  const listQuery = trpc.memories.listFlagged.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const memories = (listQuery.data?.memories ?? []) as FlaggedRow[];
  const [pending, startTransition] = useTransition();

  const resolve = (id: string, action: "dismiss" | "archive") =>
    startTransition(async () => {
      await resolveFlagAction(id, action);
      await listQuery.refetch();
    });

  if (listQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading flagged memories…</p>;
  }
  if (listQuery.isError) {
    return (
      <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
        Failed to load flagged memories: {listQuery.error?.message ?? "unknown error"}
      </p>
    );
  }
  if (memories.length === 0) {
    return <p className="text-sm text-muted-foreground">No flagged memories.</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {memories.map((memory) => {
        const flags = memory.flags ?? [];
        return (
          <li key={memory.id} className="rounded-md border bg-card p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <h3 className="truncate font-medium">{memory.title || "(untitled)"}</h3>
                <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                  {memory.body}
                </p>
                <ul className="mt-2 flex flex-col gap-1">
                  {flags.map((flag, i) => (
                    <li
                      key={`${flag.agent_id}-${flag.created_at}-${i}`}
                      className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs"
                    >
                      <span className="text-destructive">“{flag.reason}”</span>
                      <span className="text-muted-foreground">
                        {" "}
                        — flagged by {flag.agent_id} ·{" "}
                        {new Date(flag.created_at).toLocaleDateString()}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                  {memory.agent_id ? (
                    <>
                      <span>{memory.agent_id}</span>
                      <span>·</span>
                    </>
                  ) : null}
                  <span>{new Date(memory.updated_at).toLocaleDateString()}</span>
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => resolve(memory.id, "dismiss")}
                >
                  Dismiss
                </Button>
                <Button
                  variant="outline"
                  className="border-destructive/50 text-destructive hover:bg-destructive/10"
                  disabled={pending}
                  onClick={() => resolve(memory.id, "archive")}
                >
                  Archive
                </Button>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

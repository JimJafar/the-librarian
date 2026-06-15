// Flagged review queue (spec 048 PR-2): list every memory an agent has flagged
// for review, surfacing the title, body, and each open flag's reason + flagger,
// with per-row Dismiss / Archive actions. A flag never changes a memory's
// status — these stay active until an admin adjudicates here. Dismiss clears the
// flags and keeps the memory; Archive archives it then clears the flags. Both
// go through the `resolveFlagAction` server action, then refetch the queue.

"use client";

import { useTransition } from "react";
import { MemoryCard } from "./memory-card";
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
    return <p className="text-sm text-foreground/60">Loading flagged memories…</p>;
  }
  if (listQuery.isError) {
    return (
      <p
        role="alert"
        className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
      >
        Failed to load flagged memories: {listQuery.error?.message ?? "unknown error"}
      </p>
    );
  }
  if (memories.length === 0) {
    return <p className="text-sm text-foreground/60">No flagged memories.</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {memories.map((memory) => {
        const flags = memory.flags ?? [];
        return (
          <li key={memory.id}>
            <MemoryCard
              title={memory.title}
              body={memory.body}
              bodyMode="prose"
              meta={[
                memory.agent_id ? <span>{memory.agent_id}</span> : null,
                <span>{new Date(memory.updated_at).toLocaleDateString()}</span>,
              ]}
              actions={
                <>
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() => resolve(memory.id, "dismiss")}
                  >
                    Dismiss
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={pending}
                    onClick={() => resolve(memory.id, "archive")}
                  >
                    Archive
                  </Button>
                </>
              }
            >
              <ul className="mt-2 flex flex-col gap-1.5">
                {flags.map((flag, i) => (
                  <li
                    key={`${flag.agent_id}-${flag.created_at}-${i}`}
                    className="border border-destructive/40 bg-destructive/[0.06] px-2.5 py-1.5 text-xs leading-relaxed"
                  >
                    <span className="text-destructive">&ldquo;{flag.reason}&rdquo;</span>
                    <span className="text-foreground/60">
                      {" "}
                      — flagged by{" "}
                      <span className="font-mono text-foreground/75">
                        {flag.agent_id}
                      </span> &middot; {new Date(flag.created_at).toLocaleDateString()}
                    </span>
                  </li>
                ))}
              </ul>
            </MemoryCard>
          </li>
        );
      })}
    </ul>
  );
}

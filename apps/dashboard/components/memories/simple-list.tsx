"use client";

import { useTransition } from "react";
import { MemoryCard } from "./memory-card";
import type { MemoryRow } from "./types";
import { Button } from "@/components/ui-v2/button";

interface Action {
  label: string;
  variant?: "primary" | "outline" | "ghost" | "destructive";
  onAction: (id: string) => Promise<void>;
}

interface Props {
  memories: MemoryRow[];
  emptyMessage: string;
  actions?: Action[];
  /** Render the full memory body instead of clamping it to two lines. */
  expandBody?: boolean;
}

export function SimpleMemoryList({
  memories,
  emptyMessage,
  actions = [],
  expandBody = false,
}: Props) {
  const [pending, startTransition] = useTransition();
  if (memories.length === 0) {
    return <p className="text-sm text-foreground/60">{emptyMessage}</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {memories.map((memory) => (
        <li key={memory.id}>
          <MemoryCard
            title={memory.title}
            body={memory.body}
            bodyMode={expandBody ? "prose" : "clamp"}
            meta={[
              memory.agent_id ? <span>{memory.agent_id}</span> : null,
              <span>{new Date(memory.updated_at).toLocaleDateString()}</span>,
            ]}
            actions={
              actions.length > 0
                ? actions.map((action) => (
                    <Button
                      key={action.label}
                      variant={action.variant ?? "outline"}
                      disabled={pending}
                      onClick={() =>
                        startTransition(async () => {
                          await action.onAction(memory.id);
                        })
                      }
                    >
                      {action.label}
                    </Button>
                  ))
                : undefined
            }
          />
        </li>
      ))}
    </ul>
  );
}

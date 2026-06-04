"use client";

import { useTransition } from "react";
import type { MemoryRow } from "./types";
import { Button } from "@/components/ui-v2/button";
import { Pill } from "@/components/ui-v2/pill";

interface Action {
  label: string;
  variant?: "primary" | "outline" | "ghost";
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
    return <p className="text-sm text-muted-foreground">{emptyMessage}</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {memories.map((memory) => (
        <li key={memory.id} className="rounded-md border bg-card p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate font-medium">{memory.title || "(untitled)"}</h3>
              <p
                className={
                  expandBody
                    ? "whitespace-pre-wrap break-words text-sm text-muted-foreground"
                    : "line-clamp-2 text-sm text-muted-foreground"
                }
              >
                {memory.body}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                <Pill>{memory.category}</Pill>
                <span>{memory.visibility}</span>
                <span>·</span>
                <span>{memory.scope}</span>
                {memory.agent_id ? (
                  <>
                    <span>·</span>
                    <span>{memory.agent_id}</span>
                  </>
                ) : null}
                <span>·</span>
                <span>{new Date(memory.updated_at).toLocaleDateString()}</span>
              </div>
            </div>
            {actions.length > 0 ? (
              <div className="flex shrink-0 gap-2">
                {actions.map((action) => (
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
                ))}
              </div>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

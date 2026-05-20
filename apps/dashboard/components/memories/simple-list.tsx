"use client";

import { useTransition } from "react";
import type { MemoryRow } from "./types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface Action {
  label: string;
  variant?: "default" | "destructive" | "outline" | "secondary";
  onAction: (id: string) => Promise<void>;
}

interface Props {
  memories: MemoryRow[];
  emptyMessage: string;
  actions?: Action[];
}

export function SimpleMemoryList({ memories, emptyMessage, actions = [] }: Props) {
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
              <p className="line-clamp-2 text-sm text-muted-foreground">{memory.body}</p>
              <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                <Badge variant="outline">{memory.category}</Badge>
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
                    size="sm"
                    disabled={pending}
                    onClick={() => startTransition(() => action.onAction(memory.id))}
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

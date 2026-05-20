"use client";

import type { MemoryRow } from "./types";
import { Badge } from "@/components/ui/badge";

interface Props {
  memories: MemoryRow[];
  isLoading: boolean;
  isError: boolean;
  error?: string | undefined;
  selectedId: string | null;
  onSelect: (id: string) => void;
  offset: number;
  pageSize: number;
  hasMore: boolean;
  onOffsetChange: (next: number) => void;
}

export function MemoriesList({
  memories,
  isLoading,
  isError,
  error,
  selectedId,
  onSelect,
  offset,
  pageSize,
  hasMore,
  onOffsetChange,
}: Props) {
  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading memories…</p>;
  }
  if (isError) {
    return (
      <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
        Failed to load memories: {error ?? "unknown error"}
      </p>
    );
  }
  if (memories.length === 0) {
    return <p className="text-sm text-muted-foreground">No memories match these filters.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {memories.map((memory) => (
          <li key={memory.id}>
            <button
              type="button"
              onClick={() => onSelect(memory.id)}
              aria-pressed={selectedId === memory.id}
              className={`flex w-full flex-col gap-1 rounded-md border bg-card p-3 text-left transition-colors hover:bg-accent ${
                selectedId === memory.id ? "ring-2 ring-ring" : ""
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="truncate font-medium">{memory.title || "(untitled)"}</h3>
                <Badge variant="outline">{memory.category}</Badge>
              </div>
              <p className="line-clamp-2 text-sm text-muted-foreground">{memory.body}</p>
              <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
                <span>{memory.visibility}</span>
                <span>·</span>
                <span>{memory.scope}</span>
                {memory.project_key ? (
                  <>
                    <span>·</span>
                    <span>{memory.project_key}</span>
                  </>
                ) : null}
                <span>·</span>
                <span>updated {new Date(memory.updated_at).toLocaleDateString()}</span>
              </div>
            </button>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between text-sm">
        <button
          type="button"
          disabled={offset === 0}
          className="rounded-md border px-3 py-1 hover:bg-accent disabled:opacity-50"
          onClick={() => onOffsetChange(Math.max(0, offset - pageSize))}
        >
          Previous
        </button>
        <span className="text-muted-foreground">
          Showing {offset + 1}–{offset + memories.length}
        </span>
        <button
          type="button"
          disabled={!hasMore}
          className="rounded-md border px-3 py-1 hover:bg-accent disabled:opacity-50"
          onClick={() => onOffsetChange(offset + pageSize)}
        >
          Next
        </button>
      </div>
    </div>
  );
}

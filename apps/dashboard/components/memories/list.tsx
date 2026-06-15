"use client";

import { MemoryCard } from "./memory-card";
import type { MemoryRow } from "./types";

function formatScore(score: number): string {
  if (score > 0) return `+${score}`;
  return String(score);
}

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
  showPagination?: boolean;
  // D1.1 — opt-in multi-select for the bulk re-home flow. The set is
  // controlled by the parent so the bulk-action bar and modal can read
  // it without prop drilling.
  selectionEnabled?: boolean;
  selectedIds?: Set<string>;
  onToggleSelected?: (id: string) => void;
  // Select-all / deselect-all for the rows currently shown (one page).
  onToggleSelectAll?: (selectAll: boolean) => void;
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
  showPagination = true,
  selectionEnabled = false,
  selectedIds,
  onToggleSelected,
  onToggleSelectAll,
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
  // Select-all reflects the rows currently shown (one page); the parent keeps the
  // full cross-page selection. `indeterminate` shows a partial page selection.
  const allSelected = !!selectedIds && memories.every((m) => selectedIds.has(m.id));
  const someSelected = !!selectedIds && memories.some((m) => selectedIds.has(m.id));
  return (
    <div className="flex flex-col gap-3">
      {selectionEnabled && selectedIds && onToggleSelectAll ? (
        <label className="flex w-fit cursor-pointer items-center gap-2 px-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            aria-label="Select all on this page"
            checked={allSelected}
            ref={(el) => {
              if (el) el.indeterminate = someSelected && !allSelected;
            }}
            onChange={(e) => onToggleSelectAll(e.target.checked)}
          />
          {allSelected ? "Deselect all" : "Select all"}
        </label>
      ) : null}
      <ul className="flex flex-col gap-2">
        {memories.map((memory) => (
          <li key={memory.id} className="flex items-stretch gap-2">
            {selectionEnabled && selectedIds && onToggleSelected ? (
              <label className="flex items-center px-2" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  aria-label={`Select ${memory.title || memory.id}`}
                  checked={selectedIds.has(memory.id)}
                  onChange={() => onToggleSelected(memory.id)}
                />
              </label>
            ) : null}
            <MemoryCard
              title={memory.title}
              body={memory.body}
              bodyMode="clamp"
              selected={selectedId === memory.id}
              ariaPressed={selectedId === memory.id}
              onClick={() => onSelect(memory.id)}
              className="flex-1"
              meta={[
                memory.project_key ? <span>{memory.project_key}</span> : null,
                <span>updated {new Date(memory.updated_at).toLocaleDateString()}</span>,
                <span title="Usefulness score (clamped ±3)">
                  score {formatScore(memory.usefulness_score)}
                </span>,
              ]}
            />
          </li>
        ))}
      </ul>
      {showPagination ? (
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
      ) : null}
    </div>
  );
}

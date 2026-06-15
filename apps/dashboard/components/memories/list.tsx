"use client";

import type { ReactNode } from "react";
import { MemoryCard } from "./memory-card";
import type { MemoryRow } from "./types";
import { MemoryOrb } from "@/components/brand/memory-orb";
import { Button } from "@/components/ui-v2/button";

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
  /** Overrides the default empty-state body — parent supplies a richer
   *  EmptyState composite when the list is truly empty, or a small
   *  inline "no matches" block when filters/recall returned zero. */
  emptyState?: ReactNode;
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
  emptyState,
}: Props) {
  if (isLoading) {
    return <LoadingSkeleton />;
  }
  if (isError) {
    return (
      <p
        role="alert"
        className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
      >
        Failed to load memories: {error ?? "unknown error"}
      </p>
    );
  }
  if (memories.length === 0) {
    return (
      <>
        {emptyState ?? (
          <p className="text-sm text-foreground/60">No memories match these filters.</p>
        )}
      </>
    );
  }
  // Select-all reflects the rows currently shown (one page); the parent keeps the
  // full cross-page selection. `indeterminate` shows a partial page selection.
  const allSelected = !!selectedIds && memories.every((m) => selectedIds.has(m.id));
  const someSelected = !!selectedIds && memories.some((m) => selectedIds.has(m.id));
  return (
    <div className="flex flex-col gap-3">
      {selectionEnabled && selectedIds && onToggleSelectAll ? (
        <label className="flex w-fit cursor-pointer items-center gap-2 px-2 text-sm text-foreground/60 pointer-coarse:min-h-11 pointer-coarse:py-2">
          <input
            type="checkbox"
            aria-label="Select all on this page"
            checked={allSelected}
            ref={(el) => {
              if (el) el.indeterminate = someSelected && !allSelected;
            }}
            onChange={(e) => onToggleSelectAll(e.target.checked)}
            className="accent-ink-accent"
          />
          {allSelected ? "Deselect all" : "Select all"}
        </label>
      ) : null}
      <ul className="flex flex-col gap-1.5">
        {memories.map((memory) => (
          <li key={memory.id} className="flex items-stretch gap-2">
            {selectionEnabled && selectedIds && onToggleSelected ? (
              <label
                className="flex items-center px-2 pointer-coarse:min-w-11 pointer-coarse:justify-center"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  aria-label={`Select ${memory.title || memory.id}`}
                  checked={selectedIds.has(memory.id)}
                  onChange={() => onToggleSelected(memory.id)}
                  className="accent-ink-accent"
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
              // min-w-0 lets the flex-1 button shrink below its content's
              // min-content (the title's truncate alone clips the text but
              // doesn't free the button to shrink — without this, a long
              // unbroken title forces the row past the viewport).
              className="min-w-0 flex-1"
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
          <Button
            variant="outline"
            disabled={offset === 0}
            onClick={() => onOffsetChange(Math.max(0, offset - pageSize))}
          >
            Previous
          </Button>
          <span className="font-mono text-xs text-foreground/55">
            Showing {offset + 1}–{offset + memories.length}
          </span>
          <Button
            variant="outline"
            disabled={!hasMore}
            onClick={() => onOffsetChange(offset + pageSize)}
          >
            Next
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// Skeleton rows mirror the MemoryCard shape (title strip, body strip,
// meta strip) so the layout doesn't shift when real rows replace
// them. Pulse via the memory-orb keyframes so the breathing reads as
// the brand "consulting memory" motion rather than a generic spinner.
function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-1.5" aria-label="Loading memories">
      <div className="mb-1 flex items-center gap-2 text-sm text-foreground/55">
        <MemoryOrb size={10} pulse />
        <span className="font-mono text-[11px] uppercase tracking-wider">Consulting memory</span>
      </div>
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          aria-hidden
          className="memory-orb-pulse flex flex-col gap-2 border border-ink-hairline bg-ink-surface px-4 py-3"
          style={{ animationDelay: `${i * 0.15}s` }}
        >
          <div className="h-3 w-2/3 bg-foreground/10" />
          <div className="h-3 w-11/12 bg-foreground/[0.06]" />
          <div className="h-3 w-3/4 bg-foreground/[0.06]" />
          <div className="mt-1 h-2 w-1/3 bg-foreground/[0.05]" />
        </div>
      ))}
    </div>
  );
}

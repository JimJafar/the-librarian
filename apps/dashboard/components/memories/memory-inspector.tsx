"use client";

// Right-rail Inspector for /memories (md+) — keeps the list visible
// while the operator reads / edits / archives a memory. Mobile gets
// MemoryBottomSheet instead (shares the same MemoryDetailContent
// body). Hidden below `lg` so view.tsx routes to the sheet there.

import { MemoryDetailContent } from "./memory-detail-content";
import type { MemoryRow } from "./types";
import { Pill } from "@/components/ui-v2/pill";

interface Props {
  memory: MemoryRow | null;
  onClose: () => void;
  onMutated: () => void;
}

export function MemoryInspector({ memory, onClose, onMutated }: Props) {
  if (!memory) {
    return (
      <aside
        aria-label="Memory inspector"
        className="hidden h-full w-full flex-col gap-3 border-l border-ink-hairline bg-foreground/[0.02] p-5 lg:flex"
      >
        <h2 className="font-display text-xl text-foreground">Inspector</h2>
        <p className="text-sm text-foreground/55">
          Pick a memory from the list to read it, edit it, discuss it with the curator, or archive
          it.
        </p>
      </aside>
    );
  }

  return (
    <aside
      aria-label={`Memory ${memory.title || memory.id}`}
      className="hidden h-full w-full flex-col border-l border-ink-hairline bg-foreground/[0.02] lg:flex"
    >
      <header className="flex items-start justify-between gap-2 border-b border-ink-hairline p-5 pb-3">
        <div className="min-w-0">
          <h2 className="break-words font-display text-xl text-foreground">
            {memory.title || <span className="italic text-foreground/55">(untitled)</span>}
          </h2>
          {(memory.shelfId || memory.is_global || memory.requires_approval) && (
            <div className="mt-2 flex flex-wrap gap-1">
              {memory.shelfId ? (
                <Pill
                  data-shelf-token
                  variant="muted"
                  title={memory.shelfLabel ? memory.shelfId : undefined}
                >
                  {memory.shelfLabel ?? memory.shelfId}
                </Pill>
              ) : null}
              {memory.is_global ? <Pill variant="muted">global</Pill> : null}
              {memory.requires_approval ? <Pill variant="muted">requires approval</Pill> : null}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close inspector"
          className="-mr-2 -mt-1 px-2 py-1 text-foreground/55 transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent"
        >
          ×
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-5">
        <MemoryDetailContent memory={memory} onClose={onClose} onMutated={onMutated} />
      </div>
    </aside>
  );
}

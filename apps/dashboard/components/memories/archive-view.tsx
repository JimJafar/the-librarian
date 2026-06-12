// Archive page view: list archived memories with per-row checkboxes, a
// select-all control, and a bulk "Permanently delete" action (confirmed through
// ArchiveDeleteModal). Permanent delete is admin-only + irreversible from the
// app; the server `memories.purge` refuses any non-archived memory.

"use client";

import { useEffect, useState } from "react";
import { ArchiveDeleteModal } from "./archive-delete-modal";
import type { MemoryRow } from "./types";
import { Button } from "@/components/ui-v2/button";
import { trpc } from "@/lib/trpc-client";

export function ArchiveView() {
  const listQuery = trpc.memories.list.useQuery({
    status: "archived",
    limit: 100,
  } as Parameters<typeof trpc.memories.list.useQuery>[0]);
  const memories = (listQuery.data?.memories ?? []) as MemoryRow[];

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showDelete, setShowDelete] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  // Drop any selected ids that are no longer present (e.g. after a delete /
  // refetch) so the bulk count never references gone rows.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const present = new Set(memories.map((m) => m.id));
      const next = new Set([...prev].filter((id) => present.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [memories]);

  const allSelected = memories.length > 0 && memories.every((m) => selected.has(m.id));
  const someSelected = memories.some((m) => selected.has(m.id));

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = (on: boolean) =>
    setSelected(on ? new Set(memories.map((m) => m.id)) : new Set());

  if (listQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading archived memories…</p>;
  }
  if (listQuery.isError) {
    return (
      <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
        Failed to load archive: {listQuery.error?.message ?? "unknown error"}
      </p>
    );
  }
  if (memories.length === 0) {
    return <p className="text-sm text-muted-foreground">No archived memories.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <label className="flex w-fit cursor-pointer items-center gap-2 px-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            aria-label="Select all archived memories"
            checked={allSelected}
            ref={(el) => {
              if (el) el.indeterminate = someSelected && !allSelected;
            }}
            onChange={(e) => toggleAll(e.target.checked)}
          />
          {allSelected ? "Deselect all" : "Select all"}
        </label>
        {selected.size > 0 ? (
          <Button
            variant="outline"
            className="border-destructive/50 text-destructive hover:bg-destructive/10"
            onClick={() => setShowDelete(true)}
            aria-label={`Permanently delete ${selected.size} archived memories`}
          >
            Permanently delete ({selected.size})
          </Button>
        ) : null}
      </div>
      {toast ? (
        <div
          role="status"
          className="rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm"
        >
          {toast}
        </div>
      ) : null}
      <ul className="flex flex-col gap-2">
        {memories.map((memory) => (
          <li key={memory.id} className="flex items-stretch gap-2">
            <label className="flex items-center px-2">
              <input
                type="checkbox"
                aria-label={`Select ${memory.title || memory.id}`}
                checked={selected.has(memory.id)}
                onChange={() => toggle(memory.id)}
              />
            </label>
            <div className="min-w-0 flex-1 rounded-md border bg-card p-3">
              <h3 className="truncate font-medium">{memory.title || "(untitled)"}</h3>
              <p className="line-clamp-2 text-sm text-muted-foreground">{memory.body}</p>
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
          </li>
        ))}
      </ul>
      <ArchiveDeleteModal
        open={showDelete}
        onOpenChange={setShowDelete}
        memories={memories.filter((m) => selected.has(m.id))}
        onDeleted={(count) => {
          setSelected(new Set());
          setToast(`Permanently deleted ${count} memor${count === 1 ? "y" : "ies"}.`);
          listQuery.refetch();
        }}
      />
    </div>
  );
}

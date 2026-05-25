"use client";

import { useEffect, useState, useTransition } from "react";
import { MemoryDetailPanel } from "./detail-panel";
import { MemoriesFilters, type FilterState } from "./filters";
import { MemoriesList } from "./list";
import { NewMemoryForm } from "./new-form";
import { RehomeModal } from "./rehome-modal";
import { SortBar, type SortState } from "./sort-bar";
import type { Category, MemoryRow, Visibility } from "./types";
import { recallAction } from "@/app/(memories)/actions";
import { Button } from "@/components/ui-v2/button";
import { Input } from "@/components/ui-v2/input";
import { trpc } from "@/lib/trpc-client";

const PAGE_SIZE = 25;
const INITIAL_FILTERS: FilterState = {
  search: "",
  agent_id: "",
  project_key: "",
  category: "",
  visibility: "",
  from: "",
  to: "",
};

export function MemoriesView() {
  const [filters, setFilters] = useState<FilterState>(INITIAL_FILTERS);
  const [sort, setSort] = useState<SortState>({ field: "updated_at", order: "desc" });
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [recallResults, setRecallResults] = useState<MemoryRow[] | null>(null);
  const [recallError, setRecallError] = useState<string | null>(null);
  const [recalling, startRecall] = useTransition();
  // D1.1 — multi-select state for the re-home flow.
  const [bulkSelection, setBulkSelection] = useState<Set<string>>(new Set());
  const [showRehome, setShowRehome] = useState(false);
  const [rehomeToast, setRehomeToast] = useState<string | null>(null);

  // Toast auto-dismiss with proper cleanup on unmount / re-toast so we
  // don't try to setState on an unmounted component (next phase will
  // swap to a real toast library; this is the minimum-viable version).
  useEffect(() => {
    if (!rehomeToast) return;
    const timer = setTimeout(() => setRehomeToast(null), 4000);
    return () => clearTimeout(timer);
  }, [rehomeToast]);

  const listInput = {
    status: "active",
    sort: sort.field,
    order: sort.order,
    limit: PAGE_SIZE,
    offset,
    ...(filters.agent_id ? { agent_id: filters.agent_id } : {}),
    ...(filters.project_key ? { project_key: filters.project_key } : {}),
    ...(filters.category ? { category: filters.category as Category } : {}),
    ...(filters.visibility ? { visibility: filters.visibility as Visibility } : {}),
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
  } as Parameters<typeof trpc.memories.list.useQuery>[0];

  const listQuery = trpc.memories.list.useQuery(listInput);
  const listMemories = listQuery.data?.memories ?? [];
  const total = listQuery.data?.total ?? 0;
  const displayed = recallResults ?? filterClientSide(listMemories, filters.search);
  const selected = displayed.find((m) => m.id === selectedId) ?? null;

  const handleRecall = () => {
    const query = filters.search.trim();
    if (!query) return;
    startRecall(async () => {
      const result = await recallAction(query);
      if (result.ok) {
        setRecallError(null);
        setRecallResults(result.memories);
      } else {
        setRecallError(result.error);
      }
    });
  };

  return (
    <div className="grid min-h-screen grid-cols-[280px_1fr]">
      <aside className="border-r bg-muted/30 p-4">
        <div className="mb-4 flex items-center gap-2">
          <Input
            placeholder="Search / recall query…"
            value={filters.search}
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
          />
        </div>
        <MemoriesFilters
          filters={filters}
          onChange={(next) => {
            setFilters(next);
            setOffset(0);
          }}
          onRecall={handleRecall}
          recalling={recalling}
        />
        {recallError ? <p className="mt-2 text-xs text-destructive">{recallError}</p> : null}
      </aside>
      {/* min-w-0: this is the grid's 1fr track — without it, wide content (the
          list table, long ids) forces the column past the viewport width. */}
      <main className="flex min-w-0 flex-col gap-4 p-6">
        <header className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">Memories</h1>
          <div className="flex items-center gap-2">
            <SortBar sort={sort} onChange={setSort} />
            {bulkSelection.size > 0 ? (
              <Button
                variant="primary"
                onClick={() => setShowRehome(true)}
                aria-label={`Re-home ${bulkSelection.size} selected memories`}
              >
                Re-home ({bulkSelection.size})
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => setShowNewForm((v) => !v)}>
              {showNewForm ? "Cancel" : "New memory"}
            </Button>
          </div>
        </header>
        {rehomeToast ? (
          <div
            role="status"
            className="rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm"
          >
            {rehomeToast}
          </div>
        ) : null}
        {showNewForm ? (
          <NewMemoryForm
            onSaved={() => {
              setShowNewForm(false);
              listQuery.refetch();
            }}
          />
        ) : null}
        {recallResults ? (
          <div className="flex items-center justify-between rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm">
            <span>
              Showing {recallResults.length} recall result
              {recallResults.length === 1 ? "" : "s"} for &quot;{filters.search}&quot;
            </span>
            <Button
              variant="ghost"
              onClick={() => {
                setRecallResults(null);
                setSelectedId(null);
              }}
            >
              Clear
            </Button>
          </div>
        ) : null}
        {/* min-w-0 keeps the list/table from blowing the flex column past the
            available width (flex items default to min-content). The detail view
            is a modal (portaled to <body>), so the list always spans full width. */}
        <section className="min-w-0 flex-1">
          <MemoriesList
            memories={displayed}
            isLoading={!recallResults && listQuery.isLoading}
            isError={!recallResults && listQuery.isError}
            error={listQuery.error?.message}
            selectedId={selectedId}
            onSelect={setSelectedId}
            offset={recallResults ? 0 : offset}
            pageSize={PAGE_SIZE}
            hasMore={!recallResults && offset + listMemories.length < total}
            onOffsetChange={setOffset}
            showPagination={!recallResults}
            selectionEnabled
            selectedIds={bulkSelection}
            onToggleSelected={(id) =>
              setBulkSelection((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
          />
        </section>
        {selected ? (
          <MemoryDetailPanel
            memory={selected}
            onClose={() => setSelectedId(null)}
            onMutated={() => {
              listQuery.refetch();
              if (recallResults) setRecallResults(null);
            }}
          />
        ) : null}
        <RehomeModal
          open={showRehome}
          onOpenChange={setShowRehome}
          selectedIds={[...bulkSelection]}
          onSuccess={(count) => {
            setBulkSelection(new Set());
            setRehomeToast(`Re-homed ${count} memor${count === 1 ? "y" : "ies"}.`);
            listQuery.refetch();
          }}
        />
      </main>
    </div>
  );
}

function filterClientSide(memories: MemoryRow[], term: string): MemoryRow[] {
  if (!term) return memories;
  const needle = term.toLowerCase();
  return memories.filter(
    (m) => m.title.toLowerCase().includes(needle) || m.body.toLowerCase().includes(needle),
  );
}

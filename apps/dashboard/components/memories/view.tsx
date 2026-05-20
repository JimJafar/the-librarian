"use client";

import { useState, useTransition } from "react";
import { MemoryDetailPanel } from "./detail-panel";
import { MemoriesFilters, type FilterState } from "./filters";
import { MemoriesList } from "./list";
import { NewMemoryForm } from "./new-form";
import { SortBar, type SortState } from "./sort-bar";
import type { Category, MemoryRow, Visibility } from "./types";
import { recallAction } from "@/app/(memories)/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
      <main className="flex flex-col gap-4 p-6">
        <header className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">Memories</h1>
          <div className="flex items-center gap-2">
            <SortBar sort={sort} onChange={setSort} />
            <Button variant="outline" size="sm" onClick={() => setShowNewForm((v) => !v)}>
              {showNewForm ? "Cancel" : "New memory"}
            </Button>
          </div>
        </header>
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
              size="sm"
              onClick={() => {
                setRecallResults(null);
                setSelectedId(null);
              }}
            >
              Clear
            </Button>
          </div>
        ) : null}
        <section className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-[1fr_400px]">
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
          />
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
        </section>
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

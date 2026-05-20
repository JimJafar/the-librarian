"use client";

import { useState } from "react";
import { MemoryDetailPanel } from "./detail-panel";
import { MemoriesFilters, type FilterState } from "./filters";
import { MemoriesList } from "./list";
import { NewMemoryForm } from "./new-form";
import { SortBar, type SortState } from "./sort-bar";
import type { Category, Visibility } from "./types";
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
  const memories = listQuery.data?.memories ?? [];
  const filtered = filters.search
    ? memories.filter((m) => matchesSearch(m, filters.search))
    : memories;
  const selected = filtered.find((m) => m.id === selectedId) ?? null;

  return (
    <div className="grid min-h-screen grid-cols-[280px_1fr]">
      <aside className="border-r bg-muted/30 p-4">
        <div className="mb-4 flex items-center gap-2">
          <Input
            placeholder="Search loaded memories…"
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
          onRecall={() => listQuery.refetch()}
        />
      </aside>
      <main className="flex flex-col gap-4 p-6">
        <header className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">Memories</h1>
          <div className="flex items-center gap-2">
            <SortBar sort={sort} onChange={setSort} />
            <button
              type="button"
              className="rounded-md border px-3 py-2 text-sm hover:bg-accent"
              onClick={() => setShowNewForm((v) => !v)}
            >
              {showNewForm ? "Cancel" : "New memory"}
            </button>
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
        <section className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-[1fr_400px]">
          <MemoriesList
            memories={filtered}
            isLoading={listQuery.isLoading}
            isError={listQuery.isError}
            error={listQuery.error?.message}
            selectedId={selectedId}
            onSelect={setSelectedId}
            offset={offset}
            pageSize={PAGE_SIZE}
            hasMore={memories.length === PAGE_SIZE}
            onOffsetChange={setOffset}
          />
          {selected ? (
            <MemoryDetailPanel
              memory={selected}
              onClose={() => setSelectedId(null)}
              onMutated={() => listQuery.refetch()}
            />
          ) : null}
        </section>
      </main>
    </div>
  );
}

function matchesSearch(memory: { title: string; body: string }, term: string): boolean {
  const needle = term.toLowerCase();
  return memory.title.toLowerCase().includes(needle) || memory.body.toLowerCase().includes(needle);
}

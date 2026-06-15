"use client";

import { isReservedId } from "@librarian/core/caller-identity";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { type ActiveFilter, FilterChips, type FilterDef } from "./filter-chips";
import { MemoriesList } from "./list";
import { MemoryBottomSheet } from "./memory-bottom-sheet";
import { MemoryInspector } from "./memory-inspector";
import { NewMemoryForm } from "./new-form";
import { RehomeModal } from "./rehome-modal";
import { SortBar, type SortState } from "./sort-bar";
import type { MemoryRow } from "./types";
import { recallAction } from "@/app/(memories)/actions";
import { EmptyState } from "@/components/brand/empty-state";
import { Button } from "@/components/ui-v2/button";
import { KeyHint } from "@/components/ui-v2/key-hint";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui-v2/tabs";
import { useSurfaceShortcuts } from "@/hooks/use-surface-shortcuts";
import { trpc } from "@/lib/trpc-client";

const PAGE_SIZE = 25;
const LEGACY_AGENT_ID = "unknown-agent";

type Tab = "browse" | "recall";

export function MemoriesView() {
  const [tab, setTab] = useState<Tab>("browse");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<ActiveFilter[]>([]);
  const [sort, setSort] = useState<SortState>({ field: "updated_at", order: "desc" });
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [recallQuery, setRecallQuery] = useState("");
  const [recallResults, setRecallResults] = useState<MemoryRow[] | null>(null);
  const [recallError, setRecallError] = useState<string | null>(null);
  const [recalling, startRecall] = useTransition();
  const [bulkSelection, setBulkSelection] = useState<Set<string>>(new Set());
  const [showRehome, setShowRehome] = useState(false);
  const [rehomeToast, setRehomeToast] = useState<string | null>(null);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const recallInputRef = useRef<HTMLInputElement | null>(null);

  // Toast auto-dismiss with proper cleanup. Same minimum-viable shape
  // as the legacy view; next phase swaps to a real toast library.
  useEffect(() => {
    if (!rehomeToast) return;
    const timer = setTimeout(() => setRehomeToast(null), 4000);
    return () => clearTimeout(timer);
  }, [rehomeToast]);

  // Materialise active filters into the listInput shape the server
  // expects. The chips are the source of truth.
  const filtersByKey = useMemo(() => {
    const m: Record<string, string> = {};
    for (const f of filters) m[f.key] = f.value;
    return m;
  }, [filters]);

  const listInput = {
    status: "active",
    sort: sort.field,
    order: sort.order,
    limit: PAGE_SIZE,
    offset,
    ...(filtersByKey.agent_id ? { agent_id: filtersByKey.agent_id } : {}),
    ...(filtersByKey.project_key ? { project_key: filtersByKey.project_key } : {}),
    ...(filtersByKey.from ? { from: filtersByKey.from } : {}),
    ...(filtersByKey.to ? { to: filtersByKey.to } : {}),
  } as Parameters<typeof trpc.memories.list.useQuery>[0];

  const listQuery = trpc.memories.list.useQuery(listInput);
  const listMemories = listQuery.data?.memories ?? [];
  const total = listQuery.data?.total ?? 0;

  // Browse mode: server-filtered list + cheap client-side substring on
  // the search input. Recall mode: the ranked results from recallAction.
  const displayed =
    tab === "recall" ? (recallResults ?? []) : filterClientSide(listMemories, search);
  const selected = displayed.find((m) => m.id === selectedId) ?? null;

  // Filter defs — agent/project pull their option lists from the
  // distinct-values projection so the operator never types from memory.
  const agentValues = trpc.memories.distinctValues.useQuery({ field: "agent_id" });
  const projectValues = trpc.memories.distinctValues.useQuery({ field: "project_key" });
  const filterDefs: FilterDef[] = useMemo(
    () => buildFilterDefs(agentValues.data, projectValues.data),
    [agentValues.data, projectValues.data],
  );

  const handleRecall = (query: string) => {
    const q = query.trim();
    if (!q) return;
    startRecall(async () => {
      const result = await recallAction(q);
      if (result.ok) {
        setRecallError(null);
        setRecallResults(result.memories);
      } else {
        setRecallError(result.error);
      }
    });
  };

  const setFilter = (key: string, value: string, display: string) => {
    setFilters((prev) => {
      const next = prev.filter((f) => f.key !== key);
      next.push({ key, value, display });
      return next;
    });
    setOffset(0);
  };
  const removeFilter = (key: string) => {
    setFilters((prev) => prev.filter((f) => f.key !== key));
    setOffset(0);
  };
  const clearAllFilters = () => {
    setFilters([]);
    setOffset(0);
  };

  // j/k navigation through the visible list. Wraps at both ends —
  // vim convention, easier to learn than "stop at the boundary."
  const moveSelection = useCallback(
    (delta: 1 | -1) => {
      if (displayed.length === 0) return;
      const currentIndex = selectedId ? displayed.findIndex((m) => m.id === selectedId) : -1;
      const nextIndex =
        currentIndex === -1
          ? delta === 1
            ? 0
            : displayed.length - 1
          : (currentIndex + delta + displayed.length) % displayed.length;
      const nextRow = displayed[nextIndex];
      if (nextRow) setSelectedId(nextRow.id);
    },
    [displayed, selectedId],
  );

  // Per-surface shortcuts. `/` focuses the active tab's input;
  // `n` toggles the new-memory form; `r` jumps to the Recall tab
  // and focuses its input; `j`/`k` cycle the displayed list;
  // `esc` peels off context in priority order (selection →
  // recall results → no-op). Hook handles skip-when-in-input.
  useSurfaceShortcuts({
    "/": () => {
      const target = tab === "recall" ? recallInputRef.current : searchInputRef.current;
      target?.focus();
      target?.select();
    },
    n: () => setShowNewForm((v) => !v),
    r: () => {
      setTab("recall");
      // Defer so the tab content renders + the input mounts before focus.
      setTimeout(() => {
        recallInputRef.current?.focus();
        recallInputRef.current?.select();
      }, 0);
    },
    j: () => moveSelection(1),
    k: () => moveSelection(-1),
    Escape: () => {
      if (selectedId) {
        setSelectedId(null);
        return;
      }
      if (recallResults) {
        setRecallResults(null);
        setRecallError(null);
      }
    },
  });

  return (
    <>
      {/* `grid-cols-1` at <lg expands to `repeat(1, minmax(0, 1fr))` —
          critical because the implicit `auto` track sizes to max-content,
          and the row's `truncate` titles count their full nowrap width
          toward that, forcing the page wider than the viewport on long
          titles. The explicit minmax(0, 1fr) lets the track shrink. */}
      <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[1fr_360px]">
        <main className="flex min-w-0 flex-col gap-5 p-6">
          <header className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="font-display text-xl text-foreground">Memories</h1>
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
                {!showNewForm ? <KeyHint shortcut="N" /> : null}
              </Button>
            </div>
          </header>

          {rehomeToast ? (
            <div
              role="status"
              className="border border-ink-accent/40 bg-ink-accent/[0.06] px-3 py-2 text-sm text-foreground"
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

          <Tabs value={tab} onValueChange={(next) => setTab(next as Tab)}>
            <TabsList aria-label="Memory mode">
              <TabsTrigger value="browse">Browse</TabsTrigger>
              <TabsTrigger value="recall">
                Recall
                <KeyHint shortcut="R" />
              </TabsTrigger>
            </TabsList>

            <TabsContent value="browse" className="flex flex-col gap-4">
              <div className="flex flex-col gap-3">
                <div className="relative w-full max-w-xl">
                  <input
                    ref={searchInputRef}
                    type="search"
                    placeholder="Search title or body…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setSearch("");
                        e.currentTarget.blur();
                      }
                    }}
                    aria-label="Search memories"
                    className="w-full border border-ink-hairline bg-transparent px-3 py-2 pr-8 text-sm text-foreground placeholder:text-foreground/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink-accent pointer-coarse:min-h-11 pointer-coarse:text-base"
                  />
                  {!search ? (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2"
                    >
                      <KeyHint shortcut="/" />
                    </span>
                  ) : null}
                </div>
                <FilterChips
                  defs={filterDefs}
                  active={filters}
                  onSet={setFilter}
                  onRemove={removeFilter}
                  onClearAll={clearAllFilters}
                />
              </div>
              {/* min-w-0 (on the section AND its child via [&>*]) keeps the
                  list from forcing the column past viewport width. */}
              <section className="min-w-0 flex-1 [&>*]:min-w-0">
                <MemoriesList
                  memories={displayed}
                  isLoading={listQuery.isLoading}
                  isError={listQuery.isError}
                  error={listQuery.error?.message}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  offset={offset}
                  pageSize={PAGE_SIZE}
                  hasMore={offset + listMemories.length < total}
                  onOffsetChange={setOffset}
                  showPagination
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
                  onToggleSelectAll={(selectAll) =>
                    setBulkSelection((prev) => {
                      const next = new Set(prev);
                      for (const m of displayed) {
                        if (selectAll) next.add(m.id);
                        else next.delete(m.id);
                      }
                      return next;
                    })
                  }
                  emptyState={browseEmptyState({
                    hasFilters: filters.length > 0 || search.trim().length > 0,
                    onClearFilters: () => {
                      clearAllFilters();
                      setSearch("");
                    },
                    onNewMemory: () => setShowNewForm(true),
                  })}
                />
              </section>
            </TabsContent>

            <TabsContent value="recall" className="flex flex-col gap-4">
              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  handleRecall(recallQuery);
                }}
              >
                <label className="flex flex-col gap-1.5">
                  <span className="font-mono text-[11px] uppercase tracking-wider text-foreground/55">
                    Recall query
                  </span>
                  <div className="flex gap-2">
                    <input
                      ref={recallInputRef}
                      type="text"
                      value={recallQuery}
                      onChange={(e) => setRecallQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          if (recallResults) {
                            setRecallResults(null);
                            setRecallError(null);
                          } else {
                            setRecallQuery("");
                          }
                          e.currentTarget.blur();
                        }
                      }}
                      placeholder="Ask the librarian by name — claude-code after Tuesday…"
                      className="flex-1 border border-ink-hairline bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-foreground/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink-accent pointer-coarse:min-h-11 pointer-coarse:text-base"
                    />
                    <Button
                      type="submit"
                      variant="primary"
                      disabled={recalling || !recallQuery.trim()}
                    >
                      {recalling ? "Recalling…" : "Recall"}
                    </Button>
                  </div>
                </label>
                {recallError ? (
                  <p
                    role="alert"
                    className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
                  >
                    Recall failed: {recallError}. Try again, or refine the query.
                  </p>
                ) : null}
                {recallResults ? (
                  <div className="flex items-center justify-between border border-ink-accent/40 bg-ink-accent/[0.06] px-3 py-2 text-sm text-foreground">
                    <span>
                      Showing {recallResults.length} result
                      {recallResults.length === 1 ? "" : "s"} for &ldquo;{recallQuery}&rdquo;
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setRecallResults(null);
                        setRecallError(null);
                        setSelectedId(null);
                      }}
                      className="font-mono text-xs uppercase tracking-wider text-ink-accent hover:underline"
                    >
                      Clear
                    </button>
                  </div>
                ) : null}
              </form>
              <section className="min-w-0 flex-1 [&>*]:min-w-0">
                <MemoriesList
                  memories={displayed}
                  isLoading={recalling}
                  isError={false}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  offset={0}
                  pageSize={PAGE_SIZE}
                  hasMore={false}
                  onOffsetChange={() => {}}
                  showPagination={false}
                  emptyState={
                    recallResults ? (
                      <p className="text-sm text-foreground/60">
                        No memories match &ldquo;{recallQuery}&rdquo;. Try a different phrasing, or
                        switch to <span className="text-foreground/80">Browse</span> and filter by
                        agent / project.
                      </p>
                    ) : (
                      <p className="text-sm text-foreground/55">
                        Type a query above and press{" "}
                        <span className="font-mono text-foreground/80">Recall</span> (or hit Enter)
                        to ask the librarian.
                      </p>
                    )
                  }
                />
              </section>
            </TabsContent>
          </Tabs>
        </main>

        {/* Right rail (desktop only). Mobile falls back to the modal
            MemoryDetailPanel below; /impeccable adapt will replace
            the mobile modal with a bottom sheet. */}
        <MemoryInspector
          memory={selected}
          onClose={() => setSelectedId(null)}
          onMutated={() => {
            listQuery.refetch();
            if (recallResults) setRecallResults(null);
          }}
        />
      </div>

      {/* Mobile detail-view — slides up from the bottom. Hidden at
          lg+ via the parent grid (the Inspector right rail takes
          over). Wrapped in `lg:hidden` so the sheet's portaled DOM
          is also removed from the tree on desktop. */}
      <div className="lg:hidden">
        <MemoryBottomSheet
          memory={selected}
          open={!!selected}
          onOpenChange={(next) => {
            if (!next) setSelectedId(null);
          }}
          onMutated={() => {
            listQuery.refetch();
            if (recallResults) setRecallResults(null);
          }}
        />
      </div>

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
    </>
  );
}

// Two empty branches: (a) filters/search active → small inline
// "no matches" + clear handle; (b) truly empty → the hero EmptyState
// composite (librarian + constellation + first-run welcome copy).
function browseEmptyState({
  hasFilters,
  onClearFilters,
  onNewMemory,
}: {
  hasFilters: boolean;
  onClearFilters: () => void;
  onNewMemory: () => void;
}) {
  if (hasFilters) {
    return (
      <div className="flex flex-col items-start gap-3 text-sm text-foreground/60">
        <p>No memories match these filters.</p>
        <Button variant="outline" onClick={onClearFilters}>
          Clear all filters
        </Button>
      </div>
    );
  }
  return (
    <EmptyState
      title="The library is empty."
      action={
        <Button variant="primary" onClick={onNewMemory}>
          Write the first memory
        </Button>
      }
    >
      <p>
        Agents save memories automatically as you work — they&apos;ll appear here. You can also
        write the first one yourself.
      </p>
    </EmptyState>
  );
}

function filterClientSide(memories: MemoryRow[], term: string): MemoryRow[] {
  if (!term) return memories;
  const needle = term.toLowerCase();
  return memories.filter(
    (m) => m.title.toLowerCase().includes(needle) || m.body.toLowerCase().includes(needle),
  );
}

function buildFilterDefs(
  agentValues: readonly string[] | undefined,
  projectValues: readonly string[] | undefined,
): FilterDef[] {
  const agents: string[] = [];
  const systemActors: string[] = [];
  const legacy: string[] = [];
  for (const id of agentValues ?? []) {
    if (id === LEGACY_AGENT_ID) legacy.push(id);
    else if (isReservedId(id)) systemActors.push(id);
    else agents.push(id);
  }
  return [
    {
      key: "agent_id",
      label: "Agent",
      type: "select",
      groups: [
        { options: agents.map((v) => ({ value: v, label: v })) },
        ...(systemActors.length > 0
          ? [
              {
                label: "System actors",
                options: systemActors.map((v) => ({ value: v, label: v })),
              },
            ]
          : []),
        ...(legacy.length > 0
          ? [
              {
                label: "Legacy",
                options: legacy.map((v) => ({ value: v, label: `${v} (legacy)` })),
              },
            ]
          : []),
      ],
    },
    {
      key: "project_key",
      label: "Project",
      type: "select",
      groups: [{ options: (projectValues ?? []).map((v) => ({ value: v, label: v })) }],
    },
    { key: "from", label: "From", type: "date" },
    { key: "to", label: "To", type: "date" },
  ];
}

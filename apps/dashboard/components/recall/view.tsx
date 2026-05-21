// D1.3 — Recall surface.
//
// Two-pane layout: query timeline on the left (every recall + empty
// recall event, newest first), pinned memory list on the right (the
// memory_ids the selected event recorded, hydrated via the D1.3
// `memories.byIds` procedure). An insights strip at the top shows the
// three counts the spec calls out: recalls in window, empty-recall
// rate, top three queries.

"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc-client";

interface RecallEventPayload {
  agent_id?: string;
  query?: string;
  memory_ids?: string[];
  note?: string;
}

interface RecallEvent {
  event_id: string;
  event_type: string;
  agent_id: string;
  created_at: string;
  payload: RecallEventPayload;
}

const PAGE_LIMIT = 100;

export function RecallView() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const recalledQuery = trpc.memories.events.useQuery({
    type: "memory.recalled",
    limit: PAGE_LIMIT,
  });
  const emptyQuery = trpc.memories.events.useQuery({
    type: "memory.recall_empty",
    limit: PAGE_LIMIT,
  });

  const events = useMemo(() => {
    const a = (recalledQuery.data?.events ?? []) as RecallEvent[];
    const b = (emptyQuery.data?.events ?? []) as RecallEvent[];
    return [...a, ...b].sort((x, y) => y.created_at.localeCompare(x.created_at));
  }, [recalledQuery.data, emptyQuery.data]);

  const selected = events.find((e) => e.event_id === selectedId) ?? events[0] ?? null;
  const selectedIds = selected?.payload.memory_ids ?? [];

  const detail = trpc.memories.byIds.useQuery(
    { ids: selectedIds },
    { enabled: selectedIds.length > 0 },
  );

  const totalRecalls = events.length;
  const emptyCount = events.filter((e) => e.event_type === "memory.recall_empty").length;
  const emptyRate = totalRecalls === 0 ? 0 : Math.round((emptyCount / totalRecalls) * 100);
  const topQueries = useMemo(() => topNQueries(events, 3), [events]);

  return (
    <div className="flex flex-col gap-4">
      <section
        aria-label="Recall insights"
        className="flex flex-wrap items-baseline gap-6 rounded-md border bg-card px-4 py-3 text-sm"
      >
        <Stat label="Recalls" value={String(totalRecalls)} />
        <Stat label="Empty rate" value={`${emptyRate}%`} accent={emptyRate >= 30} />
        <Stat
          label="Top queries"
          value={
            topQueries.length ? topQueries.map((q) => `${q.query} (${q.count})`).join(" · ") : "—"
          }
        />
      </section>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1fr]">
        <ul
          aria-label="Recall timeline"
          className="flex max-h-[70vh] flex-col gap-1 overflow-y-auto"
        >
          {events.length === 0 ? (
            <li className="text-sm text-muted-foreground">No recall events yet.</li>
          ) : (
            events.map((e) => {
              const isEmpty = e.event_type === "memory.recall_empty";
              const isSelected = (selected?.event_id ?? "") === e.event_id;
              return (
                <li key={e.event_id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(e.event_id)}
                    aria-pressed={isSelected}
                    className={`flex w-full flex-col gap-1 rounded-md border bg-card p-2 text-left text-sm transition-colors hover:bg-accent ${
                      isSelected ? "ring-2 ring-ring" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs">
                        {e.payload.query || "(empty query)"}
                      </span>
                      {isEmpty ? (
                        <Badge variant="destructive">empty</Badge>
                      ) : (
                        <Badge variant="outline">{e.payload.memory_ids?.length ?? 0}</Badge>
                      )}
                    </div>
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{e.agent_id}</span>
                      <span>{new Date(e.created_at).toLocaleString()}</span>
                    </div>
                  </button>
                </li>
              );
            })
          )}
        </ul>
        <aside
          aria-label="Recall detail"
          className="flex flex-col gap-2 rounded-md border bg-card p-4 text-sm"
        >
          {!selected ? (
            <p className="text-muted-foreground">
              Pick a recall on the left to see what came back.
            </p>
          ) : selected.event_type === "memory.recall_empty" ? (
            <EmptyRecallDetail query={selected.payload.query || ""} />
          ) : detail.isLoading ? (
            <p className="text-muted-foreground">Loading memories…</p>
          ) : (
            <RecallMemoriesDetail
              query={selected.payload.query || ""}
              memories={detail.data?.memories ?? []}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`font-display text-xl ${accent ? "text-ink-accent" : "text-foreground"}`}>
        {value}
      </span>
    </div>
  );
}

interface MemoryDetail {
  id: string;
  title?: string | null;
  usefulness_score?: number;
  status?: string;
}

function RecallMemoriesDetail({ query, memories }: { query: string; memories: MemoryDetail[] }) {
  if (memories.length === 0) {
    return (
      <p className="text-muted-foreground">
        Returned no live memories — they may have been archived since the recall.
      </p>
    );
  }
  return (
    <>
      <p className="text-xs text-muted-foreground">
        Query: <span className="font-mono">{query}</span>
      </p>
      <ol className="flex flex-col gap-2">
        {memories.map((m, i) => (
          <li
            key={m.id}
            className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
          >
            <span>
              <span className="text-muted-foreground">{i + 1}.</span> {m.title || "(untitled)"}
            </span>
            <span className="font-mono text-xs">
              score {formatScore(m.usefulness_score ?? 0)}{" "}
              {m.status === "archived" ? "· archived" : ""}
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}

function EmptyRecallDetail({ query }: { query: string }) {
  return (
    <div className="flex flex-col gap-3">
      <p>
        This recall returned <span className="font-semibold">no memories</span> for the query:
      </p>
      <p className="font-mono text-xs">{query || "(empty)"}</p>
      <a
        href={`/?recall_query=${encodeURIComponent(query)}`}
        className="rounded-md border border-ink-accent px-3 py-1.5 text-center text-ink-accent hover:bg-ink-accent/[0.06]"
      >
        Create a memory for this query
      </a>
    </div>
  );
}

function formatScore(score: number): string {
  return score > 0 ? `+${score}` : String(score);
}

function topNQueries(events: RecallEvent[], n: number): Array<{ query: string; count: number }> {
  const counts = new Map<string, number>();
  for (const e of events) {
    const q = (e.payload.query || "").trim();
    if (!q) continue;
    counts.set(q, (counts.get(q) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([query, count]) => ({ query, count }));
}

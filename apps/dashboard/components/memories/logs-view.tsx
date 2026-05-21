"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc-client";

const EVENT_TYPES = [
  "memory.recall_empty",
  "memory.recalled",
  "memory.verified",
  "memory.created",
  "memory.proposed",
  "memory.updated",
  "memory.deleted",
  "memory.approved",
  "memory.rejected",
  "memory.conflict_detected",
  "memory.conflict_resolved",
] as const;

// "wrong" stays in the filter set so historical events remain discoverable,
// but the live `verify_memory` tool no longer accepts it — new events only
// carry useful / not_useful / outdated.
const VERIFICATION_RESULTS = [
  { value: "useful", label: "useful" },
  { value: "not_useful", label: "not_useful" },
  { value: "outdated", label: "outdated" },
  { value: "wrong", label: "wrong (legacy)" },
] as const;

const PAGE_SIZE = 25;

export function LogsView() {
  const [type, setType] = useState("");
  const [result, setResult] = useState("");
  const [agentId, setAgentId] = useState("");
  const [memoryId, setMemoryId] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);

  const input = {
    limit: PAGE_SIZE,
    offset,
    ...(type ? { type } : {}),
    ...(result ? { result } : {}),
    ...(agentId ? { agent_id: agentId } : {}),
    ...(memoryId ? { memory_id: memoryId } : {}),
    ...(query ? { query } : {}),
  } as Parameters<typeof trpc.memories.events.useQuery>[0];

  const eventsQuery = trpc.memories.events.useQuery(input);
  const events = eventsQuery.data?.events ?? [];
  const total = eventsQuery.data?.total ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3 rounded-md border bg-card p-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Event type</span>
          <select
            className="h-9 rounded-md border border-input bg-background px-2"
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">All event types</option>
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Verification result</span>
          <select
            className="h-9 rounded-md border border-input bg-background px-2"
            value={result}
            onChange={(e) => {
              setResult(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">All results</option>
            {VERIFICATION_RESULTS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Agent</span>
          <Input
            value={agentId}
            placeholder="agent id"
            onChange={(e) => {
              setAgentId(e.target.value);
              setOffset(0);
            }}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Memory ID</span>
          <Input
            value={memoryId}
            placeholder="memory id"
            onChange={(e) => {
              setMemoryId(e.target.value);
              setOffset(0);
            }}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Search</span>
          <Input
            value={query}
            placeholder="log search"
            onChange={(e) => {
              setQuery(e.target.value);
              setOffset(0);
            }}
          />
        </label>
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          {total
            ? `${offset + 1}–${Math.min(offset + events.length, total)} of ${total}`
            : "0 logs"}
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={offset + events.length >= total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Next
          </Button>
        </div>
      </div>
      {eventsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : eventsQuery.isError ? (
        <p className="text-sm text-destructive">Failed to load logs: {eventsQuery.error.message}</p>
      ) : events.length === 0 ? (
        <p className="text-sm text-muted-foreground">No logs match these filters.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {events.map((event) => (
            <li key={event.event_id} className="rounded-md border bg-card p-3 text-sm">
              <div className="flex items-baseline justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{event.event_type}</Badge>
                  <span className="text-xs text-muted-foreground">{event.agent_id}</span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {new Date(event.created_at).toLocaleString()}
                </span>
              </div>
              <pre className="mt-2 overflow-x-auto rounded-md bg-muted/40 p-2 text-xs">
                {JSON.stringify(event.payload, null, 2)}
              </pre>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

"use client";

import { CATEGORIES, VISIBILITIES } from "./types";
import { Input } from "@/components/ui-v2/input";
import { trpc } from "@/lib/trpc-client";

export interface FilterState {
  search: string;
  agent_id: string;
  project_key: string;
  category: string;
  visibility: string;
  from: string;
  to: string;
}

interface Props {
  filters: FilterState;
  onChange: (next: FilterState) => void;
  onRecall: () => void;
  recalling: boolean;
}

export function MemoriesFilters({ filters, onChange, onRecall, recalling }: Props) {
  // Data-driven dropdowns per the dashboard-redesign spec — no more
  // typing `claude-code` from memory. The values come from
  // memories.distinctValues; ordering matches the projection's
  // alphabetical sort.
  const agentValues = trpc.memories.distinctValues.useQuery({ field: "agent_id" });
  const projectValues = trpc.memories.distinctValues.useQuery({ field: "project_key" });

  const set = <K extends keyof FilterState>(key: K, value: FilterState[K]) =>
    onChange({ ...filters, [key]: value });
  return (
    <div className="flex flex-col gap-3 text-sm">
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Agent</span>
        <select
          className="h-10 rounded-md border border-input bg-background px-2"
          value={filters.agent_id}
          onChange={(e) => set("agent_id", e.target.value)}
        >
          <option value="">All agents</option>
          {(agentValues.data ?? []).map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Project</span>
        <select
          className="h-10 rounded-md border border-input bg-background px-2"
          value={filters.project_key}
          onChange={(e) => set("project_key", e.target.value)}
        >
          <option value="">All projects</option>
          {(projectValues.data ?? []).map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Category</span>
        <select
          className="h-10 rounded-md border border-input bg-background px-2"
          value={filters.category}
          onChange={(e) => set("category", e.target.value)}
        >
          <option value="">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Visibility</span>
        <select
          className="h-10 rounded-md border border-input bg-background px-2"
          value={filters.visibility}
          onChange={(e) => set("visibility", e.target.value)}
        >
          <option value="">All visibility</option>
          {VISIBILITIES.map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">From</span>
        <Input type="date" value={filters.from} onChange={(e) => set("from", e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">To</span>
        <Input type="date" value={filters.to} onChange={(e) => set("to", e.target.value)} />
      </label>
      <button
        type="button"
        disabled={recalling || !filters.search.trim()}
        className="mt-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        onClick={onRecall}
      >
        {recalling ? "Recalling…" : "Recall"}
      </button>
    </div>
  );
}

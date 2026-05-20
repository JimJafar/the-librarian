"use client";

import { useTransition } from "react";
import { CATEGORIES, VISIBILITIES } from "./types";
import { recallAction } from "@/app/(memories)/actions";
import { Input } from "@/components/ui/input";

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
}

export function MemoriesFilters({ filters, onChange, onRecall }: Props) {
  const [pending, startTransition] = useTransition();
  const set = <K extends keyof FilterState>(key: K, value: FilterState[K]) =>
    onChange({ ...filters, [key]: value });
  return (
    <div className="flex flex-col gap-3 text-sm">
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Agent</span>
        <Input
          value={filters.agent_id}
          placeholder="agent id"
          onChange={(e) => set("agent_id", e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Project</span>
        <Input
          value={filters.project_key}
          placeholder="project key"
          onChange={(e) => set("project_key", e.target.value)}
        />
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
        disabled={pending || !filters.search.trim()}
        className="mt-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        onClick={() =>
          startTransition(async () => {
            await recallAction(filters.search);
            onRecall();
          })
        }
      >
        {pending ? "Recalling…" : "Recall"}
      </button>
    </div>
  );
}

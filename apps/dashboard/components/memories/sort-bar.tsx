"use client";

import { SORT_FIELDS } from "./types";

export type SortField = (typeof SORT_FIELDS)[number]["value"];
export type SortOrder = "asc" | "desc";
export interface SortState {
  field: SortField;
  order: SortOrder;
}

interface Props {
  sort: SortState;
  onChange: (next: SortState) => void;
}

export function SortBar({ sort, onChange }: Props) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <select
        className="h-9 rounded-md border border-input bg-background px-2"
        value={sort.field}
        onChange={(e) => onChange({ ...sort, field: e.target.value as SortField })}
        aria-label="Sort field"
      >
        {SORT_FIELDS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>
      <select
        className="h-9 rounded-md border border-input bg-background px-2"
        value={sort.order}
        onChange={(e) => onChange({ ...sort, order: e.target.value as SortOrder })}
        aria-label="Sort order"
      >
        <option value="desc">Newest first</option>
        <option value="asc">Oldest first</option>
      </select>
    </div>
  );
}

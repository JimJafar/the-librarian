"use client";

// Sort controls for the Memories list — field + order, paired selects
// in the page header. Editorial chrome via the shared ui-v2 Select
// (hairline border, visible chevron + divider on the right).

import { SORT_FIELDS } from "./types";
import { Select } from "@/components/ui-v2/select";

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
      <Select
        variant="compact"
        value={sort.field}
        onChange={(e) => onChange({ ...sort, field: e.target.value as SortField })}
        aria-label="Sort field"
      >
        {SORT_FIELDS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </Select>
      <Select
        variant="compact"
        value={sort.order}
        onChange={(e) => onChange({ ...sort, order: e.target.value as SortOrder })}
        aria-label="Sort order"
      >
        <option value="desc">Newest first</option>
        <option value="asc">Oldest first</option>
      </Select>
    </div>
  );
}

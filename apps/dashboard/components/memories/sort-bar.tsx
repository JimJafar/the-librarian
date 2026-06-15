"use client";

// Sort controls for the Memories list — field + order, paired selects
// in the page header. Editorial chrome: hairline border, sharp corners,
// bg-ink-surface, ink-accent focus ring.

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

const selectClass =
  "h-8 border border-ink-hairline bg-ink-surface px-2 pr-7 text-xs text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent appearance-none bg-[url('data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\' viewBox=\\'0 0 8 5\\' fill=\\'none\\'><path d=\\'M1 1l3 3 3-3\\' stroke=\\'currentColor\\' stroke-width=\\'1\\' opacity=\\'0.5\\' stroke-linecap=\\'round\\' stroke-linejoin=\\'round\\'/></svg>')] bg-[length:8px_5px] bg-[right_8px_center] bg-no-repeat pointer-coarse:h-11 pointer-coarse:text-sm";

export function SortBar({ sort, onChange }: Props) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <select
        className={selectClass}
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
        className={selectClass}
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

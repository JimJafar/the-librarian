// Filter pill rendered above each list surface.
//
// One chip per applied filter, sitting in a horizontal row above the
// table or card stack. The dropdown that drives the value lives in
// D1.1 (data-driven distinctValues); this stub renders the chosen
// state and a remove handle.

import type { MouseEventHandler } from "react";

interface FilterChipProps {
  label: string;
  value: string;
  onRemove?: MouseEventHandler<HTMLButtonElement>;
}

export function FilterChip({ label, value, onRemove }: FilterChipProps) {
  return (
    <span className="inline-flex items-center gap-2 border border-foreground/15 bg-foreground/[0.03] px-2 py-1 text-xs">
      <span className="font-sans text-foreground/70">{label}</span>
      <span className="font-mono text-foreground">{value}</span>
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove ${label} filter`}
          onClick={onRemove}
          className="text-foreground/60 hover:text-ink-accent"
        >
          ×
        </button>
      ) : null}
    </span>
  );
}

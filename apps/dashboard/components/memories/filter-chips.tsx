"use client";

// Filter chips row + value pickers — the IA that replaces the legacy
// left-sidebar filter form (which dominated 280 px of horizontal space
// even when no filters were active).
//
// Each filter dimension has two visual states:
//   - **Inactive** ("Agent ⌄"): outlined add-chip pill, opens a popover
//     picker on click. Reads as "you can add this filter."
//   - **Active** ("Agent · claude-code ×"): filled chip showing the
//     applied value + an `×` to remove. Reads as "this filter is on,
//     here's the value, click × to clear."
//
// When more than `maxVisible` chips would render, the overflow
// collapses to a single "+N more" chip whose popover shows the rest
// (per the shape brief). Keeps the chip row to one line at typical
// viewports.
//
// The pickers (select + date) are inline lightweight popovers — no
// Radix dep, just useState + click-outside. Position is absolute
// below the trigger; the dropdown stays scoped to the chip's stacking
// context.

import { useEffect, useMemo, useRef, useState } from "react";

// ─── Types ────────────────────────────────────────────────────────

export type FilterValue = string;

export interface SelectGroup {
  label?: string;
  options: Array<{ value: FilterValue; label: string }>;
}

export type FilterDef =
  | {
      key: string;
      label: string;
      type: "select";
      groups: SelectGroup[];
      /** Optional placeholder displayed in the trigger when empty. */
    }
  | {
      key: string;
      label: string;
      type: "date";
    };

export interface ActiveFilter {
  key: string;
  /** Internal value used to filter. */
  value: FilterValue;
  /** Display string in the chip. For dates we format on insertion. */
  display: string;
}

interface FilterChipsProps {
  defs: FilterDef[];
  active: ActiveFilter[];
  onSet: (key: string, value: FilterValue, display: string) => void;
  onRemove: (key: string) => void;
  /** Trigger when the row needs to clear everything. */
  onClearAll?: () => void;
  /** Collapse chips past this count into a "+N more" trigger whose
   *  popover hosts the rest. Leave undefined to never collapse — the
   *  right default for surfaces with a fixed handful of dimensions
   *  (Memories: 4; Handoffs: 2). Pass an explicit number on surfaces
   *  where the dimension count is large enough that single-line
   *  containment matters more than visibility. */
  maxVisible?: number;
}

// ─── Public component ────────────────────────────────────────────

export function FilterChips({
  defs,
  active,
  onSet,
  onRemove,
  onClearAll,
  maxVisible,
}: FilterChipsProps) {
  // Render order: active chips first (in their natural order), then
  // outlined add-chip triggers for the inactive dimensions. The
  // overflow collapse applies to the COMBINED list so the chip row
  // stays at one line at typical viewports.
  const activeKeys = new Set(active.map((a) => a.key));
  const inactiveDefs = defs.filter((d) => !activeKeys.has(d.key));

  const allChips: Array<{ kind: "active"; data: ActiveFilter } | { kind: "add"; data: FilterDef }> =
    [
      ...active.map((a) => ({ kind: "active" as const, data: a })),
      ...inactiveDefs.map((d) => ({ kind: "add" as const, data: d })),
    ];

  const cap = maxVisible ?? allChips.length;
  const visible = allChips.slice(0, cap);
  const overflow = allChips.slice(cap);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {visible.map((chip) =>
        chip.kind === "active" ? (
          <ActiveChip
            key={chip.data.key}
            label={defLabel(defs, chip.data.key)}
            value={chip.data.display}
            onRemove={() => onRemove(chip.data.key)}
          />
        ) : (
          <AddChipTrigger
            key={chip.data.key}
            def={chip.data}
            onPick={(value, display) => onSet(chip.data.key, value, display)}
          />
        ),
      )}
      {overflow.length > 0 ? (
        <OverflowChip
          count={overflow.length}
          chips={overflow}
          defs={defs}
          onSet={onSet}
          onRemove={onRemove}
        />
      ) : null}
      {active.length > 0 && onClearAll ? (
        <button
          type="button"
          onClick={onClearAll}
          className="ml-1 font-mono text-[11px] uppercase tracking-wider text-foreground/55 transition-colors hover:text-ink-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent"
        >
          Clear all
        </button>
      ) : null}
    </div>
  );
}

function defLabel(defs: FilterDef[], key: string): string {
  return defs.find((d) => d.key === key)?.label ?? key;
}

// ─── Chip variants ────────────────────────────────────────────────

function ActiveChip({
  label,
  value,
  onRemove,
}: {
  label: string;
  value: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-2 border border-ink-accent/40 bg-ink-accent/[0.06] px-2 py-1 text-xs pointer-coarse:px-3 pointer-coarse:py-2 pointer-coarse:text-sm">
      <span className="font-mono uppercase tracking-wider text-foreground/55">{label}</span>
      <span className="font-mono text-foreground">{value}</span>
      <button
        type="button"
        aria-label={`Remove ${label} filter`}
        onClick={onRemove}
        className="-mr-1 ml-0.5 px-1 text-foreground/55 transition-colors hover:text-ink-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent pointer-coarse:px-2 pointer-coarse:text-base"
      >
        ×
      </button>
    </span>
  );
}

function AddChipTrigger({
  def,
  onPick,
}: {
  def: FilterDef;
  onPick: (value: FilterValue, display: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useClickOutside<HTMLSpanElement>(() => setOpen(false));
  return (
    <span ref={wrapperRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="inline-flex items-center gap-1.5 border border-foreground/20 bg-transparent px-2 py-1 text-xs text-foreground/70 transition-colors hover:border-foreground/30 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent pointer-coarse:min-h-11 pointer-coarse:px-3 pointer-coarse:py-2 pointer-coarse:text-sm"
      >
        <span className="font-mono uppercase tracking-wider">{def.label}</span>
        <span aria-hidden className="text-foreground/40">
          ⌄
        </span>
      </button>
      {open ? (
        <FilterPicker
          def={def}
          onPick={(value, display) => {
            onPick(value, display);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </span>
  );
}

function OverflowChip({
  count,
  chips,
  defs,
  onSet,
  onRemove,
}: {
  count: number;
  chips: Array<{ kind: "active"; data: ActiveFilter } | { kind: "add"; data: FilterDef }>;
  defs: FilterDef[];
  onSet: (key: string, value: FilterValue, display: string) => void;
  onRemove: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useClickOutside<HTMLSpanElement>(() => setOpen(false));
  return (
    <span ref={wrapperRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 border border-foreground/20 bg-transparent px-2 py-1 font-mono text-xs uppercase tracking-wider text-foreground/70 hover:border-foreground/30 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent pointer-coarse:min-h-11 pointer-coarse:px-3 pointer-coarse:py-2 pointer-coarse:text-sm"
      >
        +{count} more
      </button>
      {open ? (
        <div className="absolute left-0 top-[calc(100%+4px)] z-30 flex w-64 flex-col gap-2 border border-ink-hairline bg-ink-surface p-3 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.25)]">
          {chips.map((chip) =>
            chip.kind === "active" ? (
              <ActiveChip
                key={chip.data.key}
                label={defLabel(defs, chip.data.key)}
                value={chip.data.display}
                onRemove={() => onRemove(chip.data.key)}
              />
            ) : (
              <AddChipTrigger
                key={chip.data.key}
                def={chip.data}
                onPick={(value, display) => {
                  onSet(chip.data.key, value, display);
                  setOpen(false);
                }}
              />
            ),
          )}
        </div>
      ) : null}
    </span>
  );
}

// ─── Pickers ──────────────────────────────────────────────────────

function FilterPicker({
  def,
  onPick,
  onClose,
}: {
  def: FilterDef;
  onPick: (value: FilterValue, display: string) => void;
  onClose: () => void;
}) {
  if (def.type === "select") return <SelectPicker def={def} onPick={onPick} onClose={onClose} />;
  return <DatePicker def={def} onPick={onPick} />;
}

function SelectPicker({
  def,
  onPick,
  onClose,
}: {
  def: Extract<FilterDef, { type: "select" }>;
  onPick: (value: FilterValue, display: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const filteredGroups = useMemo(() => {
    if (!query.trim()) return def.groups;
    const q = query.trim().toLowerCase();
    return def.groups
      .map((g) => ({
        ...g,
        options: g.options.filter((o) => o.label.toLowerCase().includes(q)),
      }))
      .filter((g) => g.options.length > 0);
  }, [def.groups, query]);
  const totalCount = filteredGroups.reduce((sum, g) => sum + g.options.length, 0);

  return (
    <div
      className="absolute left-0 top-[calc(100%+4px)] z-30 w-[260px] border border-ink-hairline bg-ink-surface shadow-[0_8px_24px_-12px_rgba(0,0,0,0.25)]"
      role="listbox"
      aria-label={`${def.label} options`}
    >
      <div className="border-b border-ink-hairline p-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Filter ${def.label.toLowerCase()}…`}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
          }}
          className="w-full border border-ink-hairline bg-transparent px-2 py-1 font-mono text-xs text-foreground placeholder:text-foreground/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink-accent"
        />
      </div>
      <ul className="max-h-60 overflow-y-auto py-1">
        {totalCount === 0 ? (
          <li className="px-3 py-2 text-xs text-foreground/55">No matches</li>
        ) : (
          filteredGroups.map((group, gi) => (
            <li key={gi}>
              {group.label ? (
                <p className="px-3 pb-1 pt-2 font-mono text-[10px] uppercase tracking-wider text-foreground/55">
                  {group.label}
                </p>
              ) : null}
              <ul>
                {group.options.map((opt) => (
                  <li key={opt.value}>
                    <button
                      type="button"
                      onClick={() => onPick(opt.value, opt.label)}
                      className="block w-full truncate px-3 py-1.5 text-left font-mono text-xs text-foreground transition-colors hover:bg-foreground/[0.04] focus:bg-foreground/[0.06] focus:outline-none"
                    >
                      {opt.label}
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

function DatePicker({
  def,
  onPick,
}: {
  def: Extract<FilterDef, { type: "date" }>;
  onPick: (value: FilterValue, display: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <div className="absolute left-0 top-[calc(100%+4px)] z-30 flex w-[200px] flex-col gap-2 border border-ink-hairline bg-ink-surface p-3 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.25)]">
      <label className="font-mono text-[10px] uppercase tracking-wider text-foreground/55">
        {def.label}
      </label>
      <input
        type="date"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="border border-ink-hairline bg-transparent px-2 py-1 font-mono text-xs text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink-accent"
        autoFocus
      />
      <button
        type="button"
        disabled={!value}
        onClick={() => onPick(value, formatDate(value))}
        className="border border-ink-accent bg-transparent px-2 py-1 font-mono text-xs uppercase tracking-wider text-ink-accent transition-colors hover:bg-ink-accent/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        Apply
      </button>
    </div>
  );
}

function formatDate(iso: string): string {
  // ISO yyyy-mm-dd → locale short — operator sees their own format.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString();
}

// ─── Click-outside hook ───────────────────────────────────────────

function useClickOutside<T extends HTMLElement>(handler: () => void) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    function onDown(event: MouseEvent) {
      if (!ref.current) return;
      if (ref.current.contains(event.target as Node)) return;
      handler();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [handler]);
  return ref;
}

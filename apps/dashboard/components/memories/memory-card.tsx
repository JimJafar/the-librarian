"use client";

// The "memory card row" — the canonical body for every memory surface
// (Memories list, Proposals queue, Flagged queue, Archive list).
//
// Polished onto the rc.15 editorial system: hairline border, sharp
// corners, paper-surface fill, Newsreader title, foreground/70 body,
// mono foreground/55 meta strip. Selected state uses the same rubric
// wash + copper structural marker the vault tree row carries —
// keeps the visual vocabulary consistent across surfaces.
//
// Shared shape:
//
//   ┌────────────────────────────────────────────┐
//   │  Title                                     │
//   │  body (clamped 2 lines OR prose-wrapped)   │
//   │  children (e.g. FlaggedView's flag list)   │
//   │  agent · project · updated · score   …     │
//   └────────────────────────────────────────────┘
//
// Variants:
//   - `onClick` present → renders a <button>, clickable row pattern
//     (Memories list). Selection state via `selected` adds the ring.
//   - `actions` present → splits the row horizontally: body left,
//     action buttons right (Proposals approve/reject, Flagged
//     dismiss/archive).
//   - Both can apply together; without either, it's a static card.
//
// Meta tokens are passed as a plain array of `ReactNode`. The
// component renders the dot dividers between them so callers don't
// have to interleave `<span>·</span>` manually.

import type { ElementType, MouseEventHandler, ReactNode } from "react";

interface MemoryCardProps {
  title: string;
  body: string;
  /** Full prose vs 2-line clamp. Default `clamp` keeps a dense list
   *  scannable; `prose` is for queues where the whole content matters
   *  (Proposals review, Flagged review). */
  bodyMode?: "clamp" | "prose";
  /** Right-aligned meta tokens — agent / project / dates / scores.
   *  The component renders dot dividers between non-null entries; pass
   *  `null` for absent fields and they're filtered out. */
  meta?: Array<ReactNode | null | undefined>;
  /** Renders between the body and the meta strip — e.g. the per-flag
   *  list on FlaggedView, or any other surface-specific addendum. */
  children?: ReactNode;
  /** Visual selection state. Adds the existing `ring-2 ring-ring`
   *  treatment used by the Memories list. */
  selected?: boolean;
  onClick?: MouseEventHandler<HTMLElement>;
  /** Slot for action buttons rendered to the right of the body. Click
   *  events here `stopPropagation` so they never trigger the row's
   *  click handler. */
  actions?: ReactNode;
  className?: string;
  /** Pass-through for the clickable <button> variant. */
  ariaPressed?: boolean;
  ariaLabel?: string;
}

export function MemoryCard({
  title,
  body,
  bodyMode = "clamp",
  meta,
  children,
  selected = false,
  onClick,
  actions,
  className = "",
  ariaPressed,
  ariaLabel,
}: MemoryCardProps) {
  const Tag = (onClick ? "button" : "div") as ElementType;
  const interactive = Tag === "button";

  // Editorial chrome: hairline border, sharp corners, paper-surface fill,
  // hover wash + focus-visible bloom that match the vault tree row.
  // Selected gets the verdigris wash + a 2 px copper structural marker
  // on the left edge (matches the vault tree active row).
  const base = "relative border border-ink-hairline bg-ink-surface px-4 py-3";
  const interactiveClasses = interactive
    ? "flex w-full flex-col gap-1 text-left transition-[background-color,box-shadow] hover:bg-foreground/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink-accent focus-visible:[box-shadow:var(--glow-accent-subtle)]"
    : "";
  const selectedClasses = selected
    ? "bg-ink-accent/[0.08] pl-[14px] before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:bg-ink-copper before:content-['']"
    : "";

  const inner = (
    <>
      <h3 className="truncate text-sm font-medium text-foreground">
        {title || <span className="italic text-foreground/55">(untitled)</span>}
      </h3>
      <p
        className={
          bodyMode === "prose"
            ? "whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/70"
            : "line-clamp-2 text-sm leading-relaxed text-foreground/70"
        }
      >
        {body}
      </p>
      {children}
      {/* In the interactive flow the parent <button> already gap-1's
          its children — passing `tight` drops the meta strip's own
          mt-1 so we don't double the spacing. The two static flows
          need the mt-1 because their inner column has no gap. */}
      {meta ? <MetaStrip tokens={meta} tight={interactive} /> : null}
    </>
  );

  // Static + actions variant: body+meta in a left flex column, actions
  // right-aligned. Matches the SimpleMemoryList / FlaggedView layout
  // shape (`flex items-start justify-between gap-2`).
  if (!interactive && actions) {
    return (
      <div className={`${base} ${className}`.trim()} aria-label={ariaLabel}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">{inner}</div>
          <div className="flex shrink-0 gap-2" onClick={(e) => e.stopPropagation()}>
            {actions}
          </div>
        </div>
      </div>
    );
  }

  // Static no-actions: just the card, body fills it (Archive list row).
  if (!interactive) {
    return (
      <div className={`${base} ${className}`.trim()} aria-label={ariaLabel}>
        {inner}
      </div>
    );
  }

  // Interactive (button): flex-col gap-1 internally — the Memories
  // list row. Actions on an interactive row aren't expected by any
  // current caller, but if added they'd nest below the body.
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={ariaPressed}
      aria-label={ariaLabel}
      className={`${base} ${interactiveClasses} ${selectedClasses} ${className}`.trim()}
    >
      {inner}
      {actions ? (
        <div className="mt-1 flex gap-2" onClick={(e) => e.stopPropagation()}>
          {actions}
        </div>
      ) : null}
    </button>
  );
}

function MetaStrip({
  tokens,
  tight = false,
}: {
  tokens: Array<ReactNode | null | undefined>;
  tight?: boolean;
}) {
  const visible = tokens.filter((t) => t !== null && t !== undefined && t !== false) as ReactNode[];
  if (visible.length === 0) return null;
  return (
    <div
      className={`flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-[11px] text-foreground/55${
        tight ? "" : " mt-1"
      }`}
    >
      {visible.map((token, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 ? <span aria-hidden>·</span> : null}
          {token}
        </span>
      ))}
    </div>
  );
}

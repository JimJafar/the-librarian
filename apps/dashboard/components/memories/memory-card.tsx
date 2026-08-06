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
//   │  agent · updated   …                       │
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

import type { MouseEventHandler, ReactNode } from "react";
import { MemoryTags } from "./memory-tags";

interface MemoryCardProps {
  title: string;
  body: string;
  tags?: readonly string[];
  onTagSelect?: (tag: string) => void;
  /** Full prose vs 2-line clamp. Default `clamp` keeps a dense list
   *  scannable; `prose` is for queues where the whole content matters
   *  (Proposals review, Flagged review). */
  bodyMode?: "clamp" | "prose";
  /** Right-aligned meta tokens — agent / dates.
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
  tags = [],
  onTagSelect,
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
  const interactive = onClick !== undefined;

  // Editorial chrome: hairline border, sharp corners, paper-surface fill,
  // hover wash + focus-visible bloom that match the vault tree row.
  // Selected gets the verdigris wash + a 2 px copper structural marker
  // on the left edge (matches the vault tree active row).
  const base = "relative border border-ink-hairline bg-ink-surface px-4 py-3";
  const interactiveClasses = interactive
    ? "transition-[background-color,box-shadow] hover:bg-foreground/[0.03] focus-within:ring-2 focus-within:ring-inset focus-within:ring-ink-accent focus-within:[box-shadow:var(--glow-accent-subtle)]"
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
      <MemoryTags
        tags={tags}
        {...(onTagSelect ? { onSelect: onTagSelect } : {})}
        className="mt-1"
      />
      {/* In the interactive flow the parent <button> already gap-1's
          its children — passing `tight` drops the meta strip's own
          mt-1 so we don't double the spacing. The two static flows
          need the mt-1 because their inner column has no gap. */}
      {meta ? <MetaStrip tokens={meta} tight={interactive} /> : null}
    </>
  );

  // Static + actions variant: body+meta in a left flex column, actions
  // right-aligned. Matches the FlaggedView layout shape
  // (`flex items-start justify-between gap-2`).
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

  // Interactive cards keep their controls as siblings: the main trigger,
  // tag controls, and any actions are never nested inside one another.
  return (
    <div
      className={`${base} ${interactiveClasses} ${selectedClasses} ${className}`.trim()}
      onClick={onClick}
    >
      <button
        type="button"
        aria-pressed={ariaPressed}
        aria-label={ariaLabel}
        className="flex w-full flex-col gap-1 text-left focus:outline-none"
      >
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
      </button>
      <MemoryTags
        tags={tags}
        {...(onTagSelect ? { onSelect: onTagSelect } : {})}
        className="mt-1"
      />
      {meta ? <MetaStrip tokens={meta} /> : null}
      {actions ? (
        <div className="mt-1 flex gap-2" onClick={(e) => e.stopPropagation()}>
          {actions}
        </div>
      ) : null}
    </div>
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

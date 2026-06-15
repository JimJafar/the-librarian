"use client";

// The knowledge-graph backdrop — the thin, low-opacity geometric web
// that sits behind hero / empty / landing surfaces and reads as the AI
// substrate made visible. Library materials in the foreground;
// networked nodes humming quietly behind them.
//
// Hand-tuned 280×280 tile: 9 nodes positioned to feel composed rather
// than uniform-grid, with edges drawn between nearby pairs. The
// `<pattern>` tiles seamlessly across whatever surface it backs.
// Edges in `ink-brass-soft`, nodes split between `ink-brass` (warmer,
// always-on) and `ink-accent` (the rubric — used sparingly here to
// suggest active memory) so the system's two accent roles read here
// too without competing.
//
// Animation is opt-in via the `live` prop — when on, three nodes pulse
// in a 6s staggered cycle (slow, ambient, not attention-grabbing).
// Respects `prefers-reduced-motion`: the pulse keyframes are inert.
//
// Never used on dense data surfaces — decoration that crowds tables
// or forms is the slop failure mode the redesign exists to avoid.

import type { CSSProperties } from "react";

export function ConstellationBackdrop({
  live = false,
  opacity = 0.5,
  className = "",
}: {
  /** Animate the node-pulse cycle. Off by default; turn on for landing /
   *  empty surfaces where the gentle motion adds presence. */
  live?: boolean;
  /** Whole-pattern opacity — defaults to 0.5 since the inks already use
   *  low alpha; surfaces can dim further if they sit over content. */
  opacity?: number;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`.trim()}
      style={{ opacity } as CSSProperties}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="100%"
        height="100%"
        className="absolute inset-0"
      >
        <defs>
          <pattern
            id="librarian-constellation"
            x="0"
            y="0"
            width="280"
            height="280"
            patternUnits="userSpaceOnUse"
          >
            {/* Edges — thin, brass-soft, the connective tissue. */}
            <g stroke="var(--ink-brass-soft)" strokeWidth="0.6" fill="none">
              <line x1="32" y1="48" x2="118" y2="92" />
              <line x1="118" y1="92" x2="204" y2="46" />
              <line x1="118" y1="92" x2="86" y2="178" />
              <line x1="204" y1="46" x2="246" y2="138" />
              <line x1="86" y1="178" x2="178" y2="216" />
              <line x1="246" y1="138" x2="178" y2="216" />
              <line x1="178" y1="216" x2="52" y2="252" />
              <line x1="86" y1="178" x2="52" y2="252" />
              <line x1="246" y1="138" x2="262" y2="240" />
            </g>
            {/* Brass nodes — the always-on archive points. */}
            <g fill="var(--ink-brass)">
              <circle cx="32" cy="48" r="1.6" />
              <circle cx="204" cy="46" r="1.4" />
              <circle cx="246" cy="138" r="1.4" />
              <circle cx="86" cy="178" r="1.4" />
              <circle cx="52" cy="252" r="1.6" />
              <circle cx="262" cy="240" r="1.4" />
            </g>
            {/* Rubric nodes — the active-memory markers; these are the
                ones that pulse when `live` is on. Each gets its own
                animation phase so the surface breathes rather than
                blinking in sync. */}
            <circle
              cx="118"
              cy="92"
              r="2.2"
              fill="var(--ink-accent)"
              className={live ? "constellation-pulse" : ""}
              style={live ? ({ animationDelay: "0s" } as CSSProperties) : undefined}
            />
            <circle
              cx="178"
              cy="216"
              r="2.2"
              fill="var(--ink-accent)"
              className={live ? "constellation-pulse" : ""}
              style={live ? ({ animationDelay: "2s" } as CSSProperties) : undefined}
            />
          </pattern>
        </defs>
        <rect x="0" y="0" width="100%" height="100%" fill="url(#librarian-constellation)" />
      </svg>
    </div>
  );
}

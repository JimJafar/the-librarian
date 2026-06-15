// The memory orb — the small illuminated dot the librarian holds in the
// reference illustrations, lifted out as a primitive for loading and
// active-state moments where a hard spinner would feel mechanical and
// "this thing is consulting memory" is the truer reading.
//
// Pure SVG, no JS state. Animation runs via the `pulse` prop + the
// `memory-orb-pulse` keyframes in globals.css. Reduced-motion: the
// keyframes shorten to a single frame so users who opt out see a
// static glow rather than nothing at all.

import type { CSSProperties } from "react";

export function MemoryOrb({
  size = 12,
  pulse = false,
  className = "",
}: {
  /** Pixel diameter. 8–12 for inline / list-row use, 16–24 for headers,
   *  32+ for hero loading states. */
  size?: number;
  /** Run the breathing animation. Off by default so callers opt in. */
  pulse?: boolean;
  className?: string;
}) {
  // The bloom (drop-shadow filter) is what carries the "lit" reading
  // and what makes the orb feel different from a flat dot. Scaled with
  // the orb itself so a 32px orb gets a meaningfully bigger halo than
  // an 8px one.
  const bloom = Math.max(4, Math.round(size * 0.6));
  const style: CSSProperties = {
    width: size,
    height: size,
    filter: `drop-shadow(0 0 ${bloom}px var(--ink-accent))`,
  };
  return (
    <span
      aria-hidden
      className={`inline-block shrink-0 rounded-full bg-ink-accent ${
        pulse ? "memory-orb-pulse" : ""
      } ${className}`.trim()}
      style={style}
    />
  );
}

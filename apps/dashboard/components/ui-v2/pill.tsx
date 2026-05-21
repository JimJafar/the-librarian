// Mono-style chip for technical strings (mem_…, ses_…, timestamps).
//
// Variants (U2): `default` (mono-fill, neutral — for ids, timestamps,
// event types), `accent` (vermilion/saffron — for the one state per
// view that matters), `muted` (sage — for secondary/paused state).
// Editorial palette is deliberately restrained; if more variants are
// needed, lean on a Hairline + label instead of inventing colours.

import type { HTMLAttributes, ReactNode } from "react";

type Variant = "default" | "accent" | "muted";

interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: Variant;
  children: ReactNode;
}

const variants: Record<Variant, string> = {
  default: "bg-foreground/[0.06] text-foreground font-mono",
  accent: "border border-ink-accent text-ink-accent font-sans",
  muted: "border border-ink-accent-subdued text-ink-accent-subdued font-sans",
};

export function Pill({ variant = "default", children, className = "", ...rest }: PillProps) {
  const base = "inline-flex items-center gap-1 rounded-none px-1.5 py-0.5 text-xs leading-none";
  return (
    <span className={`${base} ${variants[variant]} ${className}`.trim()} {...rest}>
      {children}
    </span>
  );
}

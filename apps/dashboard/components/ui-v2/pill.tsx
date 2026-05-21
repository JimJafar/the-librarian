// Mono-style chip for technical strings (mem_…, ses_…, timestamps).
//
// Real "click to copy" interaction lands in D1.1; this stub only
// pins the typography (mono) and the chip background so the rest
// of the redesign can rely on it.

import type { HTMLAttributes, ReactNode } from "react";

interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode;
}

export function Pill({ children, className = "", ...rest }: PillProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-none bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-xs leading-none text-foreground ${className}`.trim()}
      {...rest}
    >
      {children}
    </span>
  );
}

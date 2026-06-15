// Mono small-caps section label — the DESIGN.md canonical "label"
// type style lifted into a component so per-pane headings ("Properties",
// "Backlinks", "Filters", "Recent activity", etc.) all wear the same
// treatment instead of drifting through copy-pasted inline classes.
//
// Voice: IBM Plex Mono · 0.6875rem (11px) · medium · 0.08em tracked
// uppercase · foreground/60. Matches the `typography.label` token in
// DESIGN.md's frontmatter. Visually under-the-radar — these labels
// are scaffolding for the eye, never headlines.
//
// Polymorphic via the `as` prop: defaults to `h3` (the most common
// semantic for a section heading inside a `<section aria-label>`).
// Pass `as="h2"` / `as="div"` / etc. where the surrounding heading
// level changes.

import type { ElementType, HTMLAttributes, ReactNode } from "react";

interface SectionLabelProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
  children: ReactNode;
}

export function SectionLabel({
  as: Tag = "h3",
  className = "",
  children,
  ...rest
}: SectionLabelProps) {
  return (
    <Tag
      className={`font-mono text-[0.6875rem] font-medium uppercase tracking-[0.08em] text-foreground/60 ${className}`.trim()}
      {...rest}
    >
      {children}
    </Tag>
  );
}

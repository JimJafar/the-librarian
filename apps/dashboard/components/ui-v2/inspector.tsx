// Right-rail container used by every D1.x surface for selected-row detail.
//
// Stubs the structure (aside + heading + scrollable body) so the
// memories/recall surfaces can drop their detail content in without
// re-implementing the chrome. Collapse behaviour and the `[`
// shortcut wiring land in D1.4.

import type { ReactNode } from "react";

interface InspectorProps {
  title: string;
  children: ReactNode;
  className?: string;
}

export function Inspector({ title, children, className = "" }: InspectorProps) {
  return (
    <aside
      aria-label={title}
      className={`flex h-full w-full flex-col gap-3 border-l border-foreground/10 bg-foreground/[0.02] p-4 ${className}`.trim()}
    >
      <h2 className="font-display text-xl text-foreground">{title}</h2>
      <div className="flex-1 overflow-y-auto text-sm text-foreground">{children}</div>
    </aside>
  );
}

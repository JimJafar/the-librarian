// Status strip — the calm top-of-page summary of where the owner is in the
// auth setup. Always visible (per the shape brief): teaches the model from
// zero, no later layout jump when enforcement flips on.
//
// One dot + one sentence + a row of method pills. Verdigris dot when on,
// outlined dot when off. Method pills are the unaltered Pill primitive so
// they read the same way they do everywhere else in the system.

import type { AuthMethod } from "./methods";
import { labelForMethod } from "./methods";
import { Pill } from "@/components/ui-v2/pill";

interface StatusStripProps {
  enabled: boolean;
  methods: readonly AuthMethod[];
  ready: boolean;
}

export function StatusStrip({ enabled, methods, ready }: StatusStripProps) {
  const count = methods.length;
  const summary = enabled
    ? `Authentication on · ${count} ${count === 1 ? "method" : "methods"} configured`
    : count === 0
      ? "Authentication off · No methods configured"
      : ready
        ? `Authentication off · ${count} ${count === 1 ? "method" : "methods"} configured · ready to enable`
        : `Authentication off · ${count} ${count === 1 ? "method" : "methods"} configured`;

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 border-y border-ink-hairline bg-ink-surface px-4 py-3"
      aria-label="Authentication status"
    >
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className={
            enabled
              ? "size-2 rounded-full bg-ink-accent [box-shadow:0_0_0_3px_color-mix(in_oklch,var(--ink-accent)_18%,transparent)]"
              : "size-2 rounded-full border border-foreground/30 bg-transparent"
          }
        />
        <span className="text-sm text-foreground">{summary}</span>
      </div>
      {count ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {methods.map((method) => (
            <Pill key={method} variant={enabled ? "accent" : "default"}>
              {labelForMethod(method)}
            </Pill>
          ))}
        </div>
      ) : null}
    </div>
  );
}

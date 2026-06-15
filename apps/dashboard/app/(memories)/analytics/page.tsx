// Analytics — the memory corpus broken down by agent / project / status.
// Editorial rebuild (Phase 4): one bordered surface with three
// hairline-separated dimension sections, not three identical cards.

import { Hairline } from "@/components/ui-v2/hairline";
import { SectionLabel } from "@/components/ui-v2/section-label";
import { serverTRPC } from "@/lib/trpc-server";

export const dynamic = "force-dynamic";

interface Slice {
  value: unknown;
  count: number;
}

export default async function AnalyticsPage() {
  let aggregates: Awaited<ReturnType<typeof serverTRPC.memories.aggregates.query>> | null = null;
  let error: string | null = null;
  try {
    aggregates = await serverTRPC.memories.aggregates.query();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const dimensions = aggregates
    ? [
        { label: "By agent", data: aggregates.agents as Slice[] },
        { label: "By project", data: aggregates.projects as Slice[] },
        { label: "By status", data: aggregates.statuses as Slice[] },
      ]
    : [];

  return (
    <main className="flex flex-col gap-8 p-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-xl text-foreground">Analytics</h1>
        <p className="text-sm text-foreground/60">
          The memory corpus broken down by agent, project, and lifecycle status. Live snapshot —
          refresh for current numbers.
        </p>
      </header>

      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      {dimensions.length > 0 ? (
        <section
          className="flex flex-col gap-6 border border-ink-hairline bg-ink-surface p-5"
          aria-label="Aggregate breakdowns"
        >
          {dimensions.map((dim, i) => (
            <Dimension key={dim.label} label={dim.label} data={dim.data} dividerAbove={i > 0} />
          ))}
        </section>
      ) : null}
    </main>
  );
}

function Dimension({
  label,
  data,
  dividerAbove,
}: {
  label: string;
  data: Slice[];
  dividerAbove: boolean;
}) {
  const total = data.reduce((sum, slice) => sum + slice.count, 0);
  const singleton = data.length === 1;

  return (
    <>
      {dividerAbove ? <Hairline /> : null}
      <section className="flex flex-col gap-3" aria-label={label}>
        <header className="flex items-baseline justify-between gap-3">
          <SectionLabel as="h2">{label}</SectionLabel>
          <span className="font-mono text-xs text-foreground/60">
            {total.toLocaleString()} total
          </span>
        </header>
        {data.length === 0 ? (
          <p className="text-sm text-foreground/60">No data.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {data.map((slice) => {
              const pct = total === 0 ? 0 : Math.round((slice.count / total) * 100);
              const value = slice.value == null ? "(none)" : String(slice.value);
              return (
                <li key={value} className="flex flex-col gap-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-foreground" title={value}>
                      {value}
                    </span>
                    <span className="font-mono text-xs tabular-nums text-foreground/70">
                      {slice.count.toLocaleString()}
                      {singleton ? null : ` · ${pct}%`}
                    </span>
                  </div>
                  {/* Editorial bar: 2px sharp-corner track at foreground/8, ink-accent
                      fill. No rounded-full, no primary-color fill. */}
                  <div aria-hidden className="h-0.5 w-full overflow-hidden bg-foreground/[0.08]">
                    <div className="h-full bg-ink-accent" style={{ width: `${pct}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}

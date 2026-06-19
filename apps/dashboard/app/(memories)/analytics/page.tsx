// Analytics — a live snapshot of the corpus and the curator's LLM usage.
// Editorial rebuild: top-line stat tiles, then hairline-separated breakdown
// dimensions, then curator token usage. The dead "By project" dimension is
// gone (project_key is never populated for memories); recall-frequency stats
// are deliberately absent (recordRecall was retired in D16, so the data to
// chart "recalls over time" doesn't exist).

import { summariseCuratorUsage } from "@/components/analytics/usage";
import { Hairline } from "@/components/ui-v2/hairline";
import { SectionLabel } from "@/components/ui-v2/section-label";
import { serverTRPC } from "@/lib/trpc-server";

export const dynamic = "force-dynamic";

interface Slice {
  value: unknown;
  count: number;
}

// Grooming runs are capped at 200 server-side; token usage is summarised over
// that newest-runs window (labelled as such in the UI).
const RUN_WINDOW = 200;

export default async function AnalyticsPage() {
  const [aggRes, runsRes] = await Promise.allSettled([
    serverTRPC.memories.aggregates.query(),
    serverTRPC.grooming.runs.query({ limit: RUN_WINDOW }),
  ]);

  const aggregates = aggRes.status === "fulfilled" ? aggRes.value : null;
  const error =
    aggRes.status === "rejected"
      ? aggRes.reason instanceof Error
        ? aggRes.reason.message
        : String(aggRes.reason)
      : null;
  const runs = runsRes.status === "fulfilled" ? runsRes.value : [];
  const usage = summariseCuratorUsage(runs);

  const dimensions = aggregates
    ? [
        { label: "By agent", data: aggregates.agents as Slice[] },
        { label: "By status", data: aggregates.statuses as Slice[] },
      ]
    : [];

  return (
    <main className="flex flex-col gap-8 p-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-xl text-foreground">Analytics</h1>
        <p className="text-sm text-foreground/60">
          A live snapshot of the corpus and the curator&rsquo;s LLM usage. Refresh for current
          numbers.
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

      {aggregates ? (
        <section
          aria-label="Totals"
          className="grid grid-cols-2 gap-px border border-ink-hairline bg-ink-hairline sm:grid-cols-4"
        >
          <StatTile label="Memories" value={aggregates.total} />
          <StatTile label={`Curator runs (last ${RUN_WINDOW})`} value={usage.runs} />
          <StatTile label="Input tokens" value={usage.inputTokens} />
          <StatTile label="Output tokens" value={usage.outputTokens} />
        </section>
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

      {usage.runs > 0 ? (
        <section
          className="flex flex-col gap-3 border border-ink-hairline bg-ink-surface p-5"
          aria-label="Curator LLM usage"
        >
          <header className="flex items-baseline justify-between gap-3">
            <SectionLabel as="h2">Curator LLM usage</SectionLabel>
            <span className="font-mono text-xs text-foreground/60">
              {usage.totalTokens.toLocaleString()} tokens · {usage.completed.toLocaleString()}/
              {usage.runs.toLocaleString()} runs completed
            </span>
          </header>
          <p className="text-xs text-foreground/60">
            Tokens consumed by the grooming curator across the most recent {RUN_WINDOW} runs, by
            model.
          </p>
          {usage.byModel.length === 0 ? (
            <p className="text-sm text-foreground/60">No curator runs have recorded usage yet.</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {usage.byModel.map((m) => {
                const pct =
                  usage.totalTokens === 0 ? 0 : Math.round((m.tokens / usage.totalTokens) * 100);
                return (
                  <li key={m.model} className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 truncate text-foreground" title={m.model}>
                        {m.model}
                      </span>
                      <span className="font-mono text-xs tabular-nums text-foreground/70">
                        {m.tokens.toLocaleString()} · {m.runs.toLocaleString()} runs
                      </span>
                    </div>
                    <div aria-hidden className="h-0.5 w-full overflow-hidden bg-foreground/[0.08]">
                      <div className="h-full bg-ink-accent" style={{ width: `${pct}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}
    </main>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-1 bg-ink-surface p-4">
      <span className="font-mono text-2xl tabular-nums text-foreground">
        {value.toLocaleString()}
      </span>
      <span className="text-xs text-foreground/60">{label}</span>
    </div>
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

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
        { label: "By category", data: aggregates.categories as Slice[] },
        { label: "By project", data: aggregates.projects as Slice[] },
        { label: "By status", data: aggregates.statuses as Slice[] },
        { label: "By scope", data: aggregates.scopes as Slice[] },
      ]
    : [];
  return (
    <main className="flex flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {dimensions.length > 0 ? (
        <div className="grid gap-6 lg:grid-cols-2">
          {dimensions.map(({ label, data }) => (
            <DimensionCard key={label} label={label} data={data} />
          ))}
        </div>
      ) : null}
    </main>
  );
}

function DimensionCard({ label, data }: { label: string; data: Slice[] }) {
  const total = data.reduce((sum, slice) => sum + slice.count, 0);
  return (
    <section className="rounded-md border bg-card p-4">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="font-semibold">{label}</h2>
        <span className="text-xs text-muted-foreground">total {total}</span>
      </header>
      {data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No data.</p>
      ) : (
        <ul className="flex flex-col gap-2 text-sm">
          {data.map((slice) => {
            const pct = total === 0 ? 0 : Math.round((slice.count / total) * 100);
            const value = slice.value == null ? "(none)" : String(slice.value);
            return (
              <li key={value} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate">{value}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {slice.count} · {pct}%
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

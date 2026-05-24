// Memory-curator admin cockpit (spec §7.1 / §13) — read-only v1 view: current
// config + recent run history. Config editing and run-now land as follow-ups.

import { CuratorConfigSummary } from "@/components/curator/config-summary";
import { CuratorRunsTable } from "@/components/curator/runs-table";
import { serverTRPC } from "@/lib/trpc-server";

export const dynamic = "force-dynamic";

export default async function CuratorPage() {
  let config: Awaited<ReturnType<typeof serverTRPC.curator.config.query>> | null = null;
  let runs: Awaited<ReturnType<typeof serverTRPC.curator.runs.query>> = [];
  let error: string | null = null;
  try {
    [config, runs] = await Promise.all([
      serverTRPC.curator.config.query(),
      serverTRPC.curator.runs.query({ limit: 50 }),
    ]);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return (
    <main className="flex flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">Memory Curator</h1>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {config ? <CuratorConfigSummary config={config} /> : null}
      <section className="rounded-md border bg-card p-4" aria-label="Run history">
        <h2 className="mb-3 font-semibold">Recent runs</h2>
        <CuratorRunsTable runs={runs} />
      </section>
    </main>
  );
}

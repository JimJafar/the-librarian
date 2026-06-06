// Memory-curator admin cockpit (spec §7.1 / §13 + 042 §4). Reads the current
// curator config + run history, the named LLM providers, and the per-consumer
// (intake / grooming) provider+model selection, and passes them to the client
// components that manage them. Server component — all data is read via tRPC here.

import {
  addProviderAction,
  deleteProviderAction,
  listModelsAction,
  runCuratorNowAction,
  saveCuratorConfigAction,
  setConsumerConfigAction,
  testConnectionAction,
  updateProviderAction,
} from "@/app/curator/actions";
import { CuratorConfigForm } from "@/components/curator/config-form";
import { CuratorConfigSummary } from "@/components/curator/config-summary";
import { ConsumerModelSelector } from "@/components/curator/consumer-model-selector";
import { ProviderManager } from "@/components/curator/provider-manager";
import { RunNowButton } from "@/components/curator/run-now-button";
import { CuratorRunsTable } from "@/components/curator/runs-table";
import { serverTRPC } from "@/lib/trpc-server";

export const dynamic = "force-dynamic";

export default async function CuratorPage() {
  let config: Awaited<ReturnType<typeof serverTRPC.curator.config.query>> | null = null;
  let runs: Awaited<ReturnType<typeof serverTRPC.curator.runs.query>> = [];
  let providers: Awaited<ReturnType<typeof serverTRPC.llm.listProviders.query>> = [];
  let intake: Awaited<ReturnType<typeof serverTRPC.llm.consumerConfig.query>> | null = null;
  let grooming: Awaited<ReturnType<typeof serverTRPC.llm.consumerConfig.query>> | null = null;
  let error: string | null = null;
  try {
    [config, runs, providers, intake, grooming] = await Promise.all([
      serverTRPC.curator.config.query(),
      serverTRPC.curator.runs.query({ limit: 50 }),
      serverTRPC.llm.listProviders.query(),
      serverTRPC.llm.consumerConfig.query({ consumer: "intake" }),
      serverTRPC.llm.consumerConfig.query({ consumer: "grooming" }),
    ]);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return (
    <main className="flex flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Memory Curator</h1>
        <RunNowButton onRun={runCuratorNowAction} />
      </header>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {config ? <CuratorConfigSummary config={config} /> : null}
      {config ? <CuratorConfigForm initial={config} onSave={saveCuratorConfigAction} /> : null}

      <ProviderManager
        initialProviders={providers}
        actions={{
          onAdd: addProviderAction,
          onUpdate: updateProviderAction,
          onDelete: deleteProviderAction,
          onTest: testConnectionAction,
        }}
      />

      {intake && grooming ? (
        <section
          className="flex flex-col gap-3 rounded-md border bg-card p-4"
          aria-label="Per-consumer models"
        >
          <h2 className="font-semibold">Per-consumer models</h2>
          <ConsumerModelSelector
            consumer="intake"
            config={intake}
            providers={providers}
            onSave={setConsumerConfigAction}
            onListModels={listModelsAction}
          />
          <ConsumerModelSelector
            consumer="grooming"
            config={grooming}
            providers={providers}
            onSave={setConsumerConfigAction}
            onListModels={listModelsAction}
          />
        </section>
      ) : null}

      <section className="rounded-md border bg-card p-4" aria-label="Run history">
        <h2 className="mb-3 font-semibold">Recent runs</h2>
        <CuratorRunsTable runs={runs} />
      </section>
    </main>
  );
}

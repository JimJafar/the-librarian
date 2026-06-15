// Curator configuration cockpit (split from /curator in the Settings nav
// restructure). Houses the shared LLM provider manager and the two
// per-job sections — Intake + Grooming — each carrying enablement,
// model/config, recent runs, and run-now.

import {
  addProviderAction,
  deleteProviderAction,
  listModelsAction,
  loadIntakeOperationsAction,
  runGroomingNowAction,
  runIntakeNowAction,
  saveGroomingConfigAction,
  setConsumerConfigAction,
  setIntakeConfigAction,
  testConnectionAction,
  updateProviderAction,
} from "@/app/curator/actions";
import { GroomingConfigForm } from "@/components/curator/config-form";
import { GroomingConfigSummary } from "@/components/curator/config-summary";
import { ConsumerModelSelector } from "@/components/curator/consumer-model-selector";
import { IntakeConfigForm } from "@/components/curator/intake-config-form";
import { IntakeRunsTable } from "@/components/curator/intake-runs-table";
import { ProviderManager } from "@/components/curator/provider-manager";
import {
  RunNowButton,
  renderGroomingResult,
  renderIntakeResult,
} from "@/components/curator/run-now-button";
import { GroomingRunsTable } from "@/components/curator/runs-table";
import { serverTRPC } from "@/lib/trpc-server";

export const dynamic = "force-dynamic";

export default async function CuratorSettingsPage() {
  let config: Awaited<ReturnType<typeof serverTRPC.grooming.config.query>> | null = null;
  let runs: Awaited<ReturnType<typeof serverTRPC.grooming.runs.query>> = [];
  let providers: Awaited<ReturnType<typeof serverTRPC.llm.listProviders.query>> = [];
  let intakeConfig: Awaited<ReturnType<typeof serverTRPC.intake.config.query>> | null = null;
  let intakeRuns: Awaited<ReturnType<typeof serverTRPC.intake.runs.query>> = [];
  let intakeConsumer: Awaited<ReturnType<typeof serverTRPC.llm.consumerConfig.query>> | null = null;
  let grooming: Awaited<ReturnType<typeof serverTRPC.llm.consumerConfig.query>> | null = null;
  let error: string | null = null;
  try {
    [config, runs, providers, intakeConfig, intakeRuns, intakeConsumer, grooming] =
      await Promise.all([
        serverTRPC.grooming.config.query(),
        serverTRPC.grooming.runs.query({ limit: 50 }),
        serverTRPC.llm.listProviders.query(),
        serverTRPC.intake.config.query(),
        serverTRPC.intake.runs.query({ limit: 50 }),
        serverTRPC.llm.consumerConfig.query({ consumer: "intake" }),
        serverTRPC.llm.consumerConfig.query({ consumer: "grooming" }),
      ]);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return (
    <main className="flex flex-col gap-8 p-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-xl text-foreground">Curator</h1>
        <p className="text-sm text-foreground/60">
          Two jobs keep the corpus healthy: <strong>Intake</strong> files new submissions in the
          inbox; <strong>Grooming</strong> curates the existing corpus. Both share the LLM providers
          below.
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

      {/* Shared LLM providers — serves both jobs, so it lives once, above
          the per-job sections. */}
      <ProviderManager
        initialProviders={providers}
        actions={{
          onAdd: addProviderAction,
          onUpdate: updateProviderAction,
          onDelete: deleteProviderAction,
          onTest: testConnectionAction,
        }}
      />

      {/* --- Intake -------------------------------------------------------- */}
      <section className="flex flex-col gap-4" aria-label="Intake">
        <header className="flex items-center justify-between border-b pb-2">
          <h2 className="text-xl font-semibold">Intake</h2>
          <RunNowButton
            onRun={runIntakeNowAction}
            renderResult={renderIntakeResult}
            label="Run intake now"
            ariaLabel="Run intake now"
          />
        </header>
        {intakeConfig ? (
          <IntakeConfigForm
            enabled={intakeConfig.enabled}
            intervalMinutes={intakeConfig.intervalMinutes}
            onSave={setIntakeConfigAction}
          />
        ) : null}
        {intakeConsumer ? (
          <section
            className="flex flex-col gap-3 rounded-md border bg-card p-4"
            aria-label="Intake model"
          >
            <h3 className="font-semibold">Model</h3>
            <ConsumerModelSelector
              consumer="intake"
              config={intakeConsumer}
              providers={providers}
              onSave={setConsumerConfigAction}
              onListModels={listModelsAction}
            />
          </section>
        ) : null}
        <section className="rounded-md border bg-card p-4" aria-label="Intake run history">
          <h3 className="mb-3 font-semibold">Recent runs</h3>
          <IntakeRunsTable runs={intakeRuns} onLoadOperations={loadIntakeOperationsAction} />
        </section>
      </section>

      {/* --- Grooming ------------------------------------------------------ */}
      <section className="flex flex-col gap-4" aria-label="Grooming">
        <header className="flex items-center justify-between border-b pb-2">
          <h2 className="text-xl font-semibold">Grooming</h2>
          <RunNowButton
            onRun={runGroomingNowAction}
            renderResult={renderGroomingResult}
            label="Run grooming now"
            ariaLabel="Run grooming now"
          />
        </header>
        {config ? <GroomingConfigSummary config={config} /> : null}
        {config ? <GroomingConfigForm initial={config} onSave={saveGroomingConfigAction} /> : null}
        {grooming ? (
          <section
            className="flex flex-col gap-3 rounded-md border bg-card p-4"
            aria-label="Grooming model"
          >
            <h3 className="font-semibold">Model</h3>
            <ConsumerModelSelector
              consumer="grooming"
              config={grooming}
              providers={providers}
              onSave={setConsumerConfigAction}
              onListModels={listModelsAction}
            />
          </section>
        ) : null}
        <section className="rounded-md border bg-card p-4" aria-label="Grooming run history">
          <h3 className="mb-3 font-semibold">Recent runs</h3>
          <GroomingRunsTable runs={runs} />
        </section>
      </section>
    </main>
  );
}

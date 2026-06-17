// Curator configuration cockpit (Phase 4 rebuild). Shared LLM providers on
// top, two tabbed jobs (Intake / Grooming) below. Each tab holds the
// Enablement & schedule, Model, and Recent runs sections — flat layout,
// hairline-separated, no nested cards.

import type { CuratorConsumer } from "@librarian/core";
import {
  addProviderAction,
  deleteProviderAction,
  listModelsAction,
  loadIntakeOperationsAction,
  runGroomingNowAction,
  runIntakeNowAction,
  saveGroomingConfigAction,
  setAutoUpdateConfigAction,
  setConsumerConfigAction,
  setIntakeConfigAction,
  testConnectionAction,
  updateProviderAction,
} from "@/app/curator/actions";
import { AutoUpdateConfigForm } from "@/components/curator/autoupdate-config-form";
import { GroomingConfigForm } from "@/components/curator/config-form";
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
import { CuratorTabs } from "@/components/curator/tabs-shell";
import { Hairline } from "@/components/ui-v2/hairline";
import { SectionLabel } from "@/components/ui-v2/section-label";
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
  let autoupdate: Awaited<ReturnType<typeof serverTRPC.autoupdate.get.query>> | null = null;
  let error: string | null = null;
  try {
    [config, runs, providers, intakeConfig, intakeRuns, intakeConsumer, grooming, autoupdate] =
      await Promise.all([
        serverTRPC.grooming.config.query(),
        serverTRPC.grooming.runs.query({ limit: 50 }),
        serverTRPC.llm.listProviders.query(),
        serverTRPC.intake.config.query(),
        serverTRPC.intake.runs.query({ limit: 50 }),
        serverTRPC.llm.consumerConfig.query({ consumer: "intake" }),
        serverTRPC.llm.consumerConfig.query({ consumer: "grooming" }),
        serverTRPC.autoupdate.get.query(),
      ]);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  // Per-provider list of which consumer labels currently reference it; the
  // Delete confirm reads this so the operator sees what breaks.
  const references: Record<string, readonly string[]> = {};
  function addRef(consumer: CuratorConsumer, providerId: string | null | undefined) {
    if (!providerId) return;
    const label = consumer === "intake" ? "Intake" : "Grooming";
    references[providerId] = [...(references[providerId] ?? []), label];
  }
  addRef("intake", intakeConsumer?.providerId);
  addRef("grooming", grooming?.providerId);

  const intakeLastRun = intakeRuns[0];
  const groomingLastRun = runs[0];

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

      <ProviderManager
        initialProviders={providers}
        references={references}
        actions={{
          onAdd: addProviderAction,
          onUpdate: updateProviderAction,
          onDelete: deleteProviderAction,
          onTest: testConnectionAction,
        }}
      />

      <CuratorTabs
        intake={
          <section className="flex flex-col gap-8" aria-label="Intake">
            <section className="flex flex-col gap-3" aria-label="Intake enablement and schedule">
              <SectionLabel as="h3">Enablement &amp; schedule</SectionLabel>
              {intakeConfig ? (
                <IntakeConfigForm
                  enabled={intakeConfig.enabled}
                  intervalMinutes={intakeConfig.intervalMinutes}
                  onSave={setIntakeConfigAction}
                />
              ) : null}
            </section>

            <Hairline />

            <section className="flex flex-col gap-3" aria-label="Intake model">
              <SectionLabel as="h3">Model</SectionLabel>
              {intakeConsumer ? (
                <ConsumerModelSelector
                  consumer="intake"
                  config={intakeConsumer}
                  providers={providers}
                  onSave={setConsumerConfigAction}
                  onListModels={listModelsAction}
                />
              ) : null}
            </section>

            <Hairline />

            <section className="flex flex-col gap-3" aria-label="Intake run history">
              <header className="flex flex-wrap items-center justify-between gap-3">
                <SectionLabel as="h3">Recent runs</SectionLabel>
                <RunNowButton
                  onRun={runIntakeNowAction}
                  renderResult={renderIntakeResult}
                  label="Run intake now"
                  ariaLabel="Run intake now"
                />
              </header>
              {intakeLastRun ? (
                <p className="text-xs text-foreground/60">
                  Last run: {renderIntakeResultDigest(intakeLastRun)}
                </p>
              ) : null}
              <IntakeRunsTable runs={intakeRuns} onLoadOperations={loadIntakeOperationsAction} />
            </section>
          </section>
        }
        grooming={
          <section className="flex flex-col gap-8" aria-label="Grooming">
            <section className="flex flex-col gap-3" aria-label="Grooming enablement and schedule">
              <SectionLabel as="h3">Enablement &amp; schedule</SectionLabel>
              {config ? (
                <GroomingConfigForm initial={config} onSave={saveGroomingConfigAction} />
              ) : null}
            </section>

            <Hairline />

            <section className="flex flex-col gap-3" aria-label="Grooming model">
              <SectionLabel as="h3">Model</SectionLabel>
              {grooming ? (
                <ConsumerModelSelector
                  consumer="grooming"
                  config={grooming}
                  providers={providers}
                  onSave={setConsumerConfigAction}
                  onListModels={listModelsAction}
                />
              ) : null}
            </section>

            <Hairline />

            <section className="flex flex-col gap-3" aria-label="Grooming run history">
              <header className="flex flex-wrap items-center justify-between gap-3">
                <SectionLabel as="h3">Recent runs</SectionLabel>
                <RunNowButton
                  onRun={runGroomingNowAction}
                  renderResult={renderGroomingResult}
                  label="Run grooming now"
                  ariaLabel="Run grooming now"
                />
              </header>
              {groomingLastRun ? (
                <p className="text-xs text-foreground/60">
                  Last run: {renderGroomingRunDigest(groomingLastRun)}
                </p>
              ) : null}
              <GroomingRunsTable runs={runs} />
            </section>
          </section>
        }
      />

      <Hairline />

      {/* Server auto-update (spec 2026-06-16-server-autoupdate T4). A server-level
          concern, not a curator job — so it sits below the two job tabs as its own
          section. The dashboard only configures it; the host timer performs the
          update (spec §2). */}
      <section className="flex flex-col gap-3" aria-label="Server auto-update">
        <header className="flex flex-col gap-1.5">
          <SectionLabel as="h2">Server auto-update</SectionLabel>
          <p className="text-sm text-foreground/60">
            Keep the server current automatically. The dashboard configures auto-update; a timer on
            the host machine performs the update on the cadence you set.
          </p>
        </header>
        {autoupdate ? (
          <AutoUpdateConfigForm
            enabled={autoupdate.enabled}
            cadence={autoupdate.cadence}
            lastRunAt={autoupdate.lastRunAt}
            version={autoupdate.version}
            latest={autoupdate.latest}
            onSave={setAutoUpdateConfigAction}
          />
        ) : null}
      </section>
    </main>
  );
}

function renderIntakeResultDigest(run: { summary: string | null; status: string }): string {
  if (run.status !== "completed") return `${run.status} — ${run.summary ?? "no summary"}`;
  return run.summary ?? "completed";
}

function renderGroomingRunDigest(run: { summary: string | null; status: string }): string {
  if (run.status !== "completed") return `${run.status} — ${run.summary ?? "no summary"}`;
  return run.summary ?? "completed";
}

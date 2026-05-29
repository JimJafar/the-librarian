// Classifier admin cockpit (spec: classifier-dashboard-config) — config
// summary + form + worker controls (restart + self-test).

import {
  restartClassifierWorkerAction,
  runClassifierSelfTestAction,
  saveClassifierConfigAction,
} from "@/app/classifier/actions";
import { ClassifierConfigForm } from "@/components/classifier/config-form";
import { ClassifierConfigSummary } from "@/components/classifier/config-summary";
import { RestartWorkerButton } from "@/components/classifier/restart-worker-button";
import { SelfTestButton } from "@/components/classifier/self-test-button";
import { serverTRPC } from "@/lib/trpc-server";

export const dynamic = "force-dynamic";

export default async function ClassifierPage() {
  let config: Awaited<ReturnType<typeof serverTRPC.classifierConfig.config.query>> | null = null;
  let workerState: Awaited<
    ReturnType<typeof serverTRPC.classifierConfig.workerState.query>
  > | null = null;
  let error: string | null = null;
  try {
    [config, workerState] = await Promise.all([
      serverTRPC.classifierConfig.config.query(),
      serverTRPC.classifierConfig.workerState.query(),
    ]);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return (
    <main className="flex flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Classifier</h1>
        <div className="flex flex-wrap items-center gap-2">
          <SelfTestButton onRun={runClassifierSelfTestAction} />
          <RestartWorkerButton onRestart={restartClassifierWorkerAction} />
        </div>
      </header>

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
        >
          Failed to load classifier config: {error}
        </p>
      ) : null}

      {config && workerState ? (
        <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
          <ClassifierConfigSummary config={config} hasDrift={workerState.hasDrift} />
          <ClassifierConfigForm config={config} onSave={saveClassifierConfigAction} />
        </div>
      ) : null}
    </main>
  );
}

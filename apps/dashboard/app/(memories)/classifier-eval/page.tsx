import { ClassifierEvalRunForm } from "@/components/classifier-eval/run-form";
import {
  ClassifierEvalSoftAlert,
  type SoftAlertProps,
} from "@/components/classifier-eval/soft-alert-banner";
import { serverTRPC } from "@/lib/trpc-server";

export const dynamic = "force-dynamic";

export default async function ClassifierEvalPage() {
  let alert: SoftAlertProps | null = null;
  let alertError: string | null = null;
  try {
    alert = await serverTRPC.classifierEval.softAlert.query();
  } catch (err) {
    alertError = err instanceof Error ? err.message : String(err);
  }

  return (
    <main className="flex flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Classifier Evaluation</h1>
        <p className="text-sm text-muted-foreground">
          Run an on-demand evaluation against a remote OpenAI-compatible classifier and the bundled
          seed fixture. Each run appends a <code>classifier.evaluation_completed</code> event so the
          timeline survives reloads. (Local-provider eval lands once Section 4d wires the worker
          into mcp-server startup.)
        </p>
      </header>
      {alertError ? (
        <p className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          Soft-alert query failed: {alertError}
        </p>
      ) : alert ? (
        <ClassifierEvalSoftAlert alert={alert} />
      ) : null}
      <ClassifierEvalRunForm />
    </main>
  );
}

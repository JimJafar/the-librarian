"use server";

import type {
  ChatResponse,
  ConsolidationOperation,
  ConsolidatorTickResult,
  ConsumerConfig,
  ConsumerConfigPatch,
  CuratorConfigPatch,
  CuratorConsumer,
  CuratorJob,
  CuratorTickResult,
  LlmProvider,
  LlmProviderInput,
  LlmProviderPatch,
  ProposedAction,
} from "@librarian/core";
import { revalidatePath } from "next/cache";
import type { RouterInputs } from "@/components/memories/types";
import { serverTRPC } from "@/lib/trpc-server";

export type RunNowResult = { ok: true; result: CuratorTickResult } | { ok: false; error: string };

// Intake run-now widens the tick result with a router-applied `disabled` skip.
type IntakeRunResult = ConsolidatorTickResult | { ran: false; reason: "disabled" };
export type RunIntakeNowResult =
  | { ok: true; result: IntakeRunResult }
  | { ok: false; error: string };

export type SaveConfigResult = { ok: true } | { ok: false; error: string };

export type LoadOperationsResult =
  | { ok: true; operations: ConsolidationOperation[] }
  | { ok: false; error: string };

// Provider mutations return the fresh provider list / consumer config so the
// client can update without an extra round-trip; the page also revalidates.
export type ProviderListResult =
  | { ok: true; providers: LlmProvider[] }
  | { ok: false; error: string };
export type ConsumerConfigResult =
  | { ok: true; config: ConsumerConfig }
  | { ok: false; error: string };
export type ModelsResult = { models: string[] };
export type TestConnectionResult = { ok: boolean; error?: string };

/** Inline `{ endpoint, token }` draft OR a saved `providerId` for a model probe. */
export type ProbeInput = { providerId?: string; endpoint?: string; token?: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Admin run-now (§12) — shares the scheduler enqueue path via the curator router.
export async function runCuratorNowAction(): Promise<RunNowResult> {
  try {
    const result = await serverTRPC.curator.runNow.mutate();
    revalidatePath("/curator");
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// Save the curator config (§7.1). An empty token field leaves the stored token
// unchanged (the form never round-trips the secret); send "" explicitly to clear.
export async function saveCuratorConfigAction(
  patch: CuratorConfigPatch,
): Promise<SaveConfigResult> {
  try {
    await serverTRPC.curator.setConfig.mutate(patch);
    revalidatePath("/curator");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// --- LLM provider CRUD (spec 042 §4, B4b) -------------------------------------
// The token is write-only: an empty/omitted token on add or update leaves the
// stored secret untouched — the form never round-trips it.

export async function addProviderAction(input: LlmProviderInput): Promise<ProviderListResult> {
  try {
    await serverTRPC.llm.addProvider.mutate(input);
    const providers = await serverTRPC.llm.listProviders.query();
    revalidatePath("/curator");
    return { ok: true, providers };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

export async function updateProviderAction(
  input: { id: string } & LlmProviderPatch,
): Promise<ProviderListResult> {
  try {
    await serverTRPC.llm.updateProvider.mutate(input);
    const providers = await serverTRPC.llm.listProviders.query();
    revalidatePath("/curator");
    return { ok: true, providers };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

export async function deleteProviderAction(id: string): Promise<ProviderListResult> {
  try {
    const providers = await serverTRPC.llm.deleteProvider.mutate({ id });
    revalidatePath("/curator");
    return { ok: true, providers };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// --- Per-consumer (intake / grooming) provider+model selection ----------------

export async function setConsumerConfigAction(
  consumer: CuratorConsumer,
  patch: ConsumerConfigPatch,
): Promise<ConsumerConfigResult> {
  try {
    const config = await serverTRPC.llm.setConsumerConfig.mutate({ consumer, ...patch });
    revalidatePath("/curator");
    return { ok: true, config };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// --- Model picker + connection probe (fail-soft on the server) ----------------

export async function listModelsAction(input: ProbeInput): Promise<ModelsResult> {
  try {
    return await serverTRPC.llm.listModels.query(input);
  } catch {
    // Mirror the server's fail-soft contract: an unreachable proxy/server still
    // lets the user fall back to typing a model name.
    return { models: [] };
  }
}

export async function testConnectionAction(input: ProbeInput): Promise<TestConnectionResult> {
  try {
    return await serverTRPC.llm.testConnection.query(input);
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// --- Intake section (spec 043 C5b) --------------------------------------------
// Mirrors the grooming actions above against the C5a `intake` router. The intake
// job owns only an enablement toggle here (provider/model is the shared
// per-consumer selector); its runs are the C1 consolidation decision log.

// Admin run-now: force one inbox sweep. Surfaces the {ran:false,reason} skip
// states (disabled / incomplete_config / no_token) to the caller, never swallows.
export async function runIntakeNowAction(): Promise<RunIntakeNowResult> {
  try {
    const result = await serverTRPC.intake.runNow.mutate();
    revalidatePath("/curator");
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// Toggle intake enablement (`curator.intake.enabled`). The setting is
// authoritative (spec 043 D-E) — toggling off actually disables the job.
export async function setIntakeConfigAction(input: {
  enabled: boolean;
}): Promise<SaveConfigResult> {
  try {
    await serverTRPC.intake.setConfig.mutate(input);
    revalidatePath("/curator");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// Lazy per-run drill-down: the C1 decisions (action/outcome/confidence/rationale)
// for one consolidation run, fetched on demand when an admin expands the row.
export async function loadIntakeOperationsAction(runId: string): Promise<LoadOperationsResult> {
  try {
    const operations = await serverTRPC.intake.runOperations.query({ runId });
    return { ok: true, operations };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// --- Curator chat (spec 044 D-7 / decisions D-5/6/9/11) -----------------------
// The whole 2C self-improvement loop surfaced in the dashboard: discuss a memory
// (or the corpus) with the curator, accept its proposed fixes, and drive the
// addendum-evaluation lifecycle.

export type ChatResult = { ok: true; response: ChatResponse } | { ok: false; error: string };

// One chat turn: send the conversation so far (+ an optional memory to ground in,
// + an optional job) and get back exactly ONE response (NO streaming). The panel
// keeps the messages array client-side and appends. A non-operational chat LLM
// surfaces a clear error ("configure the chat/grooming LLM first").
export async function chatAction(input: {
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  memoryId?: string;
  job?: CuratorJob;
}): Promise<ChatResult> {
  try {
    const response = await serverTRPC.curator.chat.mutate({
      messages: input.messages,
      ...(input.memoryId ? { memoryId: input.memoryId } : {}),
      ...(input.job ? { job: input.job } : {}),
    });
    return { ok: true, response };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// Confirm a proposed action (human-in-the-loop). The chat NEVER auto-runs an
// action; the admin clicks Confirm and ONLY THEN does the matching D5 memory
// mutation run. The action's `type` selects the mutation; the rest of the action
// IS that mutation's input (the proposed-action schema mirrors the D5 inputs
// exactly), so we drop `type` and pass the rest straight through.
export type ConfirmActionResult = { ok: true } | { ok: false; error: string };

export async function confirmActionAction(action: ProposedAction): Promise<ConfirmActionResult> {
  try {
    const { type, ...input } = action;
    switch (type) {
      case "merge":
        await serverTRPC.memories.merge.mutate(input as RouterInputs["memories"]["merge"]);
        break;
      case "split":
        await serverTRPC.memories.split.mutate(input as RouterInputs["memories"]["split"]);
        break;
      case "update":
        await serverTRPC.memories.update.mutate(input as RouterInputs["memories"]["update"]);
        break;
      case "unmerge":
        await serverTRPC.memories.unmerge.mutate(input as RouterInputs["memories"]["unmerge"]);
        break;
    }
    revalidatePath("/curator");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// --- Addendum lifecycle (spec 044 D-3/D-4) ------------------------------------

export type AddendumState = {
  content: string;
  version: string | null;
  status: "accepted" | "under_evaluation";
  evalVersion: string | null;
};
export type AddendumStateResult =
  | { ok: true; addendum: AddendumState }
  | { ok: false; error: string };

// Commit a new addendum draft for a job — it goes UNDER EVALUATION (the curator
// force-proposes until accepted). Works whether or not the job is enabled (D-11):
// the edit commits and takes effect when the job next runs. The 2 KB cap is the
// hard backstop (setJobAddendum throws over-cap); surfaced as an error here.
export async function setAddendumAction(input: {
  job: CuratorJob;
  content: string;
}): Promise<AddendumStateResult> {
  try {
    const addendum = await serverTRPC.addendum.set.mutate(input);
    revalidatePath("/curator");
    return { ok: true, addendum };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// Accept the addendum under evaluation: resume auto-apply.
export async function acceptAddendumAction(input: {
  job: CuratorJob;
}): Promise<AddendumStateResult> {
  try {
    const status = await serverTRPC.addendum.accept.mutate(input);
    const current = await serverTRPC.addendum.get.query(input);
    revalidatePath("/curator");
    return { ok: true, addendum: { ...current, ...status } };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// Roll back the addendum under evaluation to its prior committed version.
export async function rollbackAddendumAction(input: {
  job: CuratorJob;
}): Promise<AddendumStateResult> {
  try {
    await serverTRPC.addendum.rollback.mutate(input);
    const current = await serverTRPC.addendum.get.query(input);
    revalidatePath("/curator");
    return { ok: true, addendum: current };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// Re-evaluate the proposals tagged with the current eval version (GROOMING ONLY —
// intake is not replayable). Returns the summary so the admin sees the count.
export type ReEvaluateResult =
  | { ok: true; result: Awaited<ReturnType<typeof serverTRPC.addendum.reEvaluate.mutate>> }
  | { ok: false; error: string };

export async function reEvaluateAddendumAction(input: {
  job: CuratorJob;
}): Promise<ReEvaluateResult> {
  try {
    const result = await serverTRPC.addendum.reEvaluate.mutate(input);
    revalidatePath("/curator");
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// Dry-run grooming with a CANDIDATE (uncommitted) addendum (GROOMING ONLY). With
// no slice it runs the whole corpus in the background and returns `{started:true}`
// immediately; the admin polls the runs/proposals for results.
type DryRunMutationResult = Awaited<ReturnType<typeof serverTRPC.curator.dryRunGrooming.mutate>>;
export type DryRunActionResult =
  | { ok: true; result: DryRunMutationResult }
  | { ok: false; error: string };

export async function dryRunGroomingAction(input: {
  candidateAddendum: string;
}): Promise<DryRunActionResult> {
  try {
    const result = await serverTRPC.curator.dryRunGrooming.mutate({
      candidateAddendum: input.candidateAddendum,
    });
    revalidatePath("/curator");
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}
